// Backfill data lama ke aturan baru: mapel per tingkat, topik milik guru,
// kelas default. Aman dijalankan berulang: semua langkah hanya menyentuh baris
// yang belum sesuai, jadi migrasi kedua tidak mengubah apa pun.

const rapi = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// Tingkat mapel lama hanya bisa disimpulkan dari ujian yang memakainya. Kolom
// topics.grade_level sudah dibuang, jadi jangan dibaca lagi.
async function tingkatMapel(pool, subjek) {
  const dariUjian = (await pool.query(
    'SELECT DISTINCT c.level FROM exams e JOIN classes c ON c.id=e.class_id WHERE e.subject_id=$1 AND c.level IS NOT NULL ORDER BY 1',
    [subjek.id]
  )).rows.map((r) => r.level);
  if (dariUjian.length) return dariUjian;

  // Mapel tanpa ujian: ambil tingkat terendah sekolah sebagai tempat menaruhnya
  // supaya tetap muncul di pemilih. Isinya kosong, jadi aman.
  const cadangan = (await pool.query(
    'SELECT MIN(level) AS level FROM classes WHERE institution_id=$1 AND level IS NOT NULL',
    [subjek.institution_id]
  )).rows[0]?.level;
  return cadangan ? [cadangan] : [];
}

async function cariAtauBuatMapel(pool, { institution_id, grade_level, name }) {
  const ada = await pool.query(
    'SELECT id FROM subjects WHERE institution_id=$1 AND grade_level=$2 AND lower(name)=lower($3) ORDER BY id LIMIT 1',
    [institution_id, grade_level, name]
  );
  if (ada.rowCount) return ada.rows[0].id;
  const baru = await pool.query(
    'INSERT INTO subjects(institution_id,grade_level,name) VALUES($1,$2,$3) RETURNING id',
    [institution_id, grade_level, name]
  );
  return baru.rows[0].id;
}

async function pecahMapelPerTingkat(pool, stat) {
  const lama = (await pool.query(
    'SELECT id, institution_id, name FROM subjects WHERE grade_level IS NULL ORDER BY id'
  )).rows;

  for (const s of lama) {
    const tingkat = await tingkatMapel(pool, s);
    if (!tingkat.length) continue;

    // Satu tingkat: baris lama cukup diberi label.
    await pool.query('UPDATE subjects SET grade_level=$1 WHERE id=$2', [tingkat[0], s.id]);
    stat.mapelDipecah++;

    // Lebih dari satu: sisanya jadi baris baru, isinya dipindahkan ke sana.
    for (const lv of tingkat.slice(1)) {
      const tujuan = await cariAtauBuatMapel(pool, { institution_id: s.institution_id, grade_level: lv, name: s.name });
      if (tujuan === s.id) continue;
      // Topik tetap di baris pertama: tanpa kolom tingkat, tidak ada petunjuk
      // topik mana milik tingkat mana. Ujiannya yang ikut pindah.
      await pool.query(
        'UPDATE exams e SET subject_id=$1 FROM classes c WHERE c.id=e.class_id AND c.level=$2 AND e.subject_id=$3',
        [tujuan, lv, s.id]
      );
      stat.mapelDipecah++;
    }
  }
}

// Mapel dengan nama sama pada tingkat sama pernah dibuat terpisah (mis. lewat
// impor). Satukan ke baris tertua supaya indeks unik bisa dipasang.
async function gabungMapelKembar(pool, stat) {
  const kembar = (await pool.query(`
    SELECT institution_id, grade_level, lower(name) AS kunci, array_agg(id ORDER BY id) AS ids
      FROM subjects WHERE grade_level IS NOT NULL
     GROUP BY 1,2,3 HAVING count(*) > 1`)).rows;

  for (const k of kembar) {
    const [tetap, ...buang] = k.ids;
    for (const id of buang) {
      await pool.query('UPDATE topics SET subject_id=$1 WHERE subject_id=$2', [tetap, id]);
      await pool.query('UPDATE questions SET subject_id=$1 WHERE subject_id=$2', [tetap, id]);
      await pool.query('UPDATE exams SET subject_id=$1 WHERE subject_id=$2', [tetap, id]);
      await pool.query('DELETE FROM subjects WHERE id=$1', [id]);
      stat.mapelDigabung++;
    }
  }
}

// Soal harus menunjuk mapel yang sama dengan topiknya setelah topik dipindah.
async function selaraskanMapelSoal(pool) {
  const r = await pool.query(`
    UPDATE questions q SET subject_id = t.subject_id
      FROM topics t
     WHERE t.id = q.topic_id AND t.subject_id IS NOT NULL AND q.subject_id IS DISTINCT FROM t.subject_id`);
  return r.rowCount;
}

// Materi lama menempel ke subbab; topiknya ditelusuri lewat bab.
async function pindahkanMateriKeTopik(pool) {
  const r = await pool.query(`
    UPDATE sources s SET topic_id = c.topic_id
      FROM sub_chapters sc JOIN chapters c ON c.id = sc.chapter_id
     WHERE s.topic_id IS NULL AND sc.id = s.sub_chapter_id AND c.topic_id IS NOT NULL`);
  return r.rowCount;
}

async function isiKelasDefault(pool, stat) {
  const r = await pool.query(`
    UPDATE users u SET default_class_id = (
      SELECT c.id FROM classes c
       WHERE c.institution_id = u.institution_id
       ORDER BY c.academic_year DESC, c.level NULLS LAST, c.name
       LIMIT 1)
     WHERE u.default_class_id IS NULL AND u.institution_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM classes c WHERE c.institution_id = u.institution_id)`);
  stat.kelasDefault = r.rowCount;
}

async function pasangIndeks(pool) {
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_tingkat ON subjects(institution_id, grade_level, lower(name));
    CREATE UNIQUE INDEX IF NOT EXISTS uq_topic_guru ON topics(created_by, subject_id, lower(name)) WHERE created_by IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id);
    CREATE INDEX IF NOT EXISTS idx_topics_owner ON topics(created_by);`);
}

async function backfill(pool) {
  const stat = { mapelDipecah: 0, mapelDigabung: 0, soalDiselaraskan: 0, kelasDefault: 0, materiKeTopik: 0 };

  // Spasi berlebih dan spasi di ujung membuat pencarian nama meleset.
  await pool.query(`UPDATE subjects SET name = btrim(regexp_replace(name, '\\s+', ' ', 'g'))
                     WHERE name <> btrim(regexp_replace(name, '\\s+', ' ', 'g'))`);
  await pool.query(`UPDATE topics SET name = btrim(regexp_replace(name, '\\s+', ' ', 'g'))
                     WHERE name <> btrim(regexp_replace(name, '\\s+', ' ', 'g'))`);

  await pecahMapelPerTingkat(pool, stat);
  await gabungMapelKembar(pool, stat);
  stat.soalDiselaraskan = await selaraskanMapelSoal(pool);
  await isiKelasDefault(pool, stat);
  stat.materiKeTopik = await pindahkanMateriKeTopik(pool);
  await pasangIndeks(pool);
  return stat;
}

module.exports = { backfill, rapi };

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('node:net');
const cheerio = require('cheerio');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { needTenant } = require('../lib/scope');
const { AppError } = require('../lib/errors');
const { audit } = require('./bantuan');

const DIR = path.join(__dirname, '..', '..', 'uploads', 'sources');
const UPLOAD = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(DIR, { recursive: true });

// Multer menyimpan nama acak tanpa ekstensi, jadi nama asli disimpan terpisah.
const namaBerkas = (s) => s.original_name || (s.file_path ? path.basename(s.file_path) : null);

// Hanya berkas di dalam folder uploads yang boleh dibaca/dihapus.
function diDalamUploads(p) {
  const f = path.resolve(p);
  return f.startsWith(path.resolve(UPLOAD) + path.sep) ? f : null;
}

async function extractText(filePath, ext) {
  if (ext === '.txt') return fs.readFileSync(filePath, 'utf8').slice(0, 200000);
  if (ext === '.pdf') {
    const pdf = require('pdf-parse');
    const d = await pdf(fs.readFileSync(filePath));
    return (d.text || '').slice(0, 200000);
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const d = await mammoth.extractRawText({ path: filePath });
    return (d.value || '').slice(0, 200000);
  }
  return '';
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return true; // tolak IPv6/non-IP demi keamanan (shortcut: upgrade bila perlu)
}

async function robotsAllowed(url) {
  try {
    const root = new URL(url).origin;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(root + '/robots.txt', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return true;
    const txt = await r.text();
    const blockAll = /^disallow:\s*\/\s*$/im.test(txt);
    return !blockAll;
  } catch {
    return true;
  }
}

// Topik harus milik sekolah yang sama; tanpa ini materi bisa menempel ke topik
// sekolah lain hanya dengan menebak id.
async function topikSah(topicId, inst) {
  if (!topicId) return false;
  const r = await pool.query(
    'SELECT 1 FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE t.id=$1 AND s.institution_id=$2',
    [topicId, inst]
  );
  return r.rowCount > 0;
}

// shortcut: ekstraksi sinkron (file kecil). Upgrade ke antrean latar bila file besar/menumpuk.
async function uploadSource(req, res) {
  const topik = Number(req.body.topic_id) || null;
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  if (!req.file) return fail(res, 400, 'VALIDATION_ERROR', 'File wajib.');
  if (!(await topikSah(topik, inst))) return fail(res, 400, 'VALIDATION_ERROR', 'Pilih topiknya dulu.');
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    const text = await extractText(req.file.path, ext);
    const txtPath = req.file.path + '.txt';
    fs.writeFileSync(txtPath, text);
    const q = await pool.query(
      "INSERT INTO sources(institution_id,topic_id,kind,file_path,extracted_path,status,created_by,original_name) VALUES($1,$2,'upload',$3,$4,'done',$5,$6) RETURNING *",
      [inst, topik, req.file.path, txtPath, req.user.id, req.file.originalname]
    );
    ok(res, { ...q.rows[0], chars: text.length }, 'Berkas materi tersimpan.');
  } catch (e) {
    await pool.query("INSERT INTO sources(institution_id,topic_id,kind,file_path,status,error,created_by) VALUES($1,$2,'upload',$3,'failed',$4,$5)", [inst, topik, req.file.path, String(e.message).slice(0, 500), req.user.id]);
    throw new AppError('SOURCE_SCRAPE_FAILED', 'Gagal mengekstrak file.');
  }
}

async function scrapeUrl(req, res) {
  const p = z.object({ url: z.string().url(), topic_id: z.number().int() }).parse(req.body);
  const u = new URL(p.url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError('SOURCE_BLOCKED_SSRF', 'Hanya http/https.');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => { throw new AppError('SOURCE_SCRAPE_FAILED', 'Domain tak dikenal.'); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new AppError('SOURCE_BLOCKED_SSRF', 'URL menunjuk ke jaringan internal, diblokir.');
  if (!(await robotsAllowed(p.url))) throw new AppError('SOURCE_BLOCKED_SSRF', 'robots.txt melarang scraping URL ini.');
  const inst = needTenant(req, res, req.body.institution_id);
  if (!inst) return;
  if (!(await topikSah(p.topic_id, inst))) return fail(res, 400, 'VALIDATION_ERROR', 'Topik tak ditemukan di sekolah ini.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let html = '';
  try {
    const resp = await fetch(p.url, { signal: ctrl.signal, headers: { 'User-Agent': 'SigesoBot/1.0 (+atribusi sumber)' } });
    if (!resp.ok) throw new AppError('SOURCE_SCRAPE_FAILED', `HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) throw new AppError('SOURCE_SCRAPE_FAILED', 'Halaman >2MB, ditolak.');
    html = buf.toString('utf8');
  } catch (e) {
    if (e.name === 'AbortError') throw new AppError('LLM_TIMEOUT', 'Scraping timeout.');
    throw e.code ? e : new AppError('SOURCE_SCRAPE_FAILED', e.message);
  } finally {
    clearTimeout(t);
  }
  const $ = cheerio.load(html);
  const text = $('article').text() || $('main').text() || $('body').text();
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200000);
  const f = path.join(DIR, `url-${Date.now()}.txt`);
  fs.writeFileSync(f, `Sumber: ${p.url}\n\n${clean}`);
  const q = await pool.query(
    "INSERT INTO sources(institution_id,topic_id,kind,original_url,extracted_path,status,created_by) VALUES($1,$2,'url',$3,$4,'done',$5) RETURNING *",
    [inst, p.topic_id, p.url, f, req.user.id]
  );
  ok(res, { ...q.rows[0], chars: clean.length }, 'Materi dari link tersimpan.');
}

async function listSources(req, res) {
  const q = req.query.topic_id
    ? await pool.query('SELECT id,kind,original_url,original_name,file_path,status,error FROM sources WHERE topic_id=$1 AND institution_id=$2 ORDER BY id DESC', [req.query.topic_id, req.user.institution_id])
    : await pool.query('SELECT id,kind,original_url,original_name,file_path,status,error FROM sources WHERE institution_id=$1 ORDER BY id DESC LIMIT 50', [req.user.institution_id]);
  // Path mentah tak perlu sampai ke layar; cukup nama berkasnya.
  ok(res, q.rows.map(({ file_path, ...s }) => ({ ...s, nama: namaBerkas({ ...s, file_path }) })));
}

// Buka/unduh berkas materi yang diunggah (wajib login, jalur dibatasi ke uploads).
async function downloadSource(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  const r = await pool.query('SELECT * FROM sources WHERE id=$1 AND institution_id=$2', [req.params.id, inst]);
  const s = r.rows[0];
  if (!s) return fail(res, 404, 'NOT_FOUND', 'Materi tak ditemukan.');
  const f = s.file_path && diDalamUploads(s.file_path);
  if (!f || !fs.existsSync(f)) return fail(res, 404, 'NOT_FOUND', 'Berkas materi sudah tak ada di server.');
  res.download(f, namaBerkas(s));
}

async function deleteSource(req, res) {
  const inst = needTenant(req, res);
  if (!inst) return;
  const r = await pool.query('SELECT * FROM sources WHERE id=$1 AND institution_id=$2', [req.params.id, inst]);
  const s = r.rows[0];
  if (!s) return fail(res, 404, 'NOT_FOUND', 'Materi tak ditemukan.');
  // questions.source_id tak memakai cascade: materi yang sudah jadi bahan soal harus dilepas dulu.
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM questions WHERE source_id=$1', [s.id])).rows[0].n;
  if (n) return fail(res, 400, 'VALIDATION_ERROR', `Materi ini dipakai ${n} soal. Hapus soalnya dulu, baru materinya bisa dibuang.`);
  await pool.query('DELETE FROM sources WHERE id=$1', [s.id]);
  for (const p of [s.file_path, s.extracted_path]) {
    const f = p && diDalamUploads(p);
    if (f) { try { fs.unlinkSync(f); } catch { /* memang sudah tak ada */ } }
  }
  await audit(req, 'delete', 'sources', s.id);
  ok(res, { id: s.id }, 'Materi dihapus.');
}

module.exports = { DIR, uploadSource, scrapeUrl, listSources, downloadSource, deleteSource };

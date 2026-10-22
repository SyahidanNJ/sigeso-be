const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

// Logo sekolah sering punya pinggiran putih/transparan, sehingga pada kotak
// cetak yang sama lambangnya terlihat lebih kecil. Pinggiran itu dibuang.

function urai(buf, ext) {
  if (ext === '.png') {
    const p = PNG.sync.read(buf);
    return { w: p.width, h: p.height, data: p.data };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const p = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { w: p.width, h: p.height, data: Buffer.from(p.data) };
  }
  return null;
}

function kotakIsi({ w, h, data }) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Sisa bayangan transparan di tepi kanvas bukan bagian lambang.
      if (data[i + 3] <= 32) continue;
      // Nyaris putih dianggap kosong; sisa piksel menentukan batas lambang.
      if (data[i] >= 235 && data[i + 1] >= 235 && data[i + 2] >= 235) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Potong pinggiran kosong lalu tulis PNG. Mengembalikan false bila berkas tak
// dikenali atau isinya nyaris kosong, supaya pemanggil memakai berkas asli.
function rapikanGambar(src, tujuan) {
  try {
    const asal = urai(fs.readFileSync(src), path.extname(src).toLowerCase());
    if (!asal) return false;
    const isi = kotakIsi(asal);
    if (!isi || isi.w * isi.h < 0.15 * asal.w * asal.h) return false;
    const tepi = Math.round(Math.max(isi.w, isi.h) * 0.02);
    const x0 = Math.max(0, isi.x - tepi);
    const y0 = Math.max(0, isi.y - tepi);
    const x1 = Math.min(asal.w, isi.x + isi.w + tepi);
    const y1 = Math.min(asal.h, isi.y + isi.h + tepi);
    const w = x1 - x0;
    const h = y1 - y0;
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      const dari = ((y + y0) * asal.w + x0) * 4;
      asal.data.copy(png.data, y * w * 4, dari, dari + w * 4);
    }
    fs.writeFileSync(tujuan, PNG.sync.write(png));
    return true;
  } catch {
    return false;
  }
}

module.exports = { rapikanGambar };

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('node:net');
const cheerio = require('cheerio');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { ok, fail } = require('../lib/respond');
const { auth, roles } = require('../middleware/auth');
const { AppError } = require('../lib/errors');

const r = express.Router();
r.use(auth);
const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const DIR = path.join(__dirname, '..', '..', 'uploads', 'sources');
fs.mkdirSync(DIR, { recursive: true });
const upload = multer({
  dest: DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    const okExt = ['.pdf', '.docx', '.txt'].includes(path.extname(f.originalname).toLowerCase());
    cb(okExt ? null : new AppError('VALIDATION_ERROR', 'Hanya PDF, DOCX, TXT.'), okExt);
  },
});

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

// shortcut: ekstraksi sinkron (file kecil). Upgrade ke pg-boss bila file besar/menumpuk.
r.post('/sources/upload', roles('superadmin', 'admin', 'guru'), upload.single('file'), asyncH(async (req, res) => {
  const sub = Number(req.body.sub_chapter_id) || null;
  const inst = req.user.role === 'superadmin' ? Number(req.body.institution_id) : req.user.institution_id;
  if (!inst) return fail(res, 400, 'VALIDATION_ERROR', 'institution_id wajib.');
  if (!req.file) return fail(res, 400, 'VALIDATION_ERROR', 'File wajib.');
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    const text = await extractText(req.file.path, ext);
    const txtPath = req.file.path + '.txt';
    fs.writeFileSync(txtPath, text);
    const q = await pool.query(
      "INSERT INTO sources(institution_id,sub_chapter_id,kind,file_path,extracted_path,status,created_by) VALUES($1,$2,'upload',$3,$4,'done',$5) RETURNING *",
      [inst, sub, req.file.path, txtPath, req.user.id]
    );
    ok(res, { ...q.rows[0], chars: text.length }, 'Materi diunggah dan diekstrak.');
  } catch (e) {
    await pool.query("INSERT INTO sources(institution_id,sub_chapter_id,kind,file_path,status,error,created_by) VALUES($1,$2,'upload',$3,'failed',$4,$5)", [inst, sub, req.file.path, String(e.message).slice(0, 500), req.user.id]);
    throw new AppError('SOURCE_SCRAPE_FAILED', 'Gagal mengekstrak file.');
  }
}));

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

r.post('/sources/url', roles('superadmin', 'admin', 'guru'), asyncH(async (req, res) => {
  const p = z.object({ url: z.string().url(), sub_chapter_id: z.number().int().optional() }).parse(req.body);
  const u = new URL(p.url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError('SOURCE_BLOCKED_SSRF', 'Hanya http/https.');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => { throw new AppError('SOURCE_SCRAPE_FAILED', 'Domain tak dikenal.'); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new AppError('SOURCE_BLOCKED_SSRF', 'URL menunjuk ke jaringan internal, diblokir.');
  if (!(await robotsAllowed(p.url))) throw new AppError('SOURCE_BLOCKED_SSRF', 'robots.txt melarang scraping URL ini.');
  const inst = req.user.role === 'superadmin' ? Number(req.body.institution_id) : req.user.institution_id;
  if (!inst) return fail(res, 400, 'VALIDATION_ERROR', 'institution_id wajib untuk superadmin.');
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
    "INSERT INTO sources(institution_id,sub_chapter_id,kind,original_url,extracted_path,status,created_by) VALUES($1,$2,'url',$3,$4,'done',$5) RETURNING *",
    [inst, p.sub_chapter_id || null, p.url, f, req.user.id]
  );
  ok(res, { ...q.rows[0], chars: clean.length }, 'URL berhasil di-scrape.');
}));

r.get('/sources', asyncH(async (req, res) => {
  const q = req.query.sub_chapter_id
    ? await pool.query('SELECT id,kind,original_url,status,error,created_at FROM sources WHERE sub_chapter_id=$1 ORDER BY id DESC', [req.query.sub_chapter_id])
    : await pool.query('SELECT id,kind,original_url,status,error,created_at FROM sources WHERE institution_id=$1 ORDER BY id DESC LIMIT 50', [req.user.institution_id]);
  ok(res, q.rows);
}));

module.exports = r;

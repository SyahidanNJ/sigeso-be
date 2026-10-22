const nodemailer = require('nodemailer');
const { AppError } = require('./errors');

// SMTP dari .env (Gmail: App Password, port 465). Kalau belum diisi, fitur
// reset sandi menjawab dengan pesan yang bisa dibaca, bukan diam-diam gagal.
let transpor = null;
function siap() {
  if (transpor) return transpor;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transpor = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transpor;
}

async function kirimEmail({ to, subject, text, html }) {
  const t = siap();
  if (!t) throw new AppError('MAIL_NOT_CONFIGURED', 'Email pengirim belum diatur di server.');
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, text, html,
    });
  } catch (e) {
    throw new AppError('MAIL_FAILED', 'Email gagal dikirim. Cek pengaturan SMTP atau coba lagi.');
  }
}

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
}

module.exports = { kirimEmail, appUrl };

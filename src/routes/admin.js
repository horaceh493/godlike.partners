const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// load the requesting admin's own row (need is_super + ref_code on every request)
router.use((req, res, next) => {
  req.adminUser = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  if (!req.adminUser) return res.status(401).json({ error: 'Admin account not found.' });
  next();
});

const UPLOADS_DIR = path.join(db.DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, crypto.randomBytes(16).toString('hex') + safeExt);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB, enough for a typical APK
  fileFilter: (req, file, cb) => {
    const allowed = ['.apk', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Only .apk or .zip files are allowed.'));
    cb(null, true);
  }
});

function serializePartner(u) {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    email: u.email,
    status: u.status,
    balance: u.balance,
    tierVolume: u.tier_volume,
    createdAt: u.created_at,
    unreadMessages: u.unread_messages || 0,
    referredByEmail: u.referred_by_email || null
  };
}

// ---------- my admin profile + referral link ----------
router.get('/me', (req, res) => {
  const a = req.adminUser;
  res.json({
    id: a.id, firstName: a.first_name, lastName: a.last_name, email: a.email,
    isSuper: !!a.is_super, refCode: a.ref_code
  });
});

// ---------- partners (scoped to this admin unless super) ----------
router.get('/partners', (req, res) => {
  const scoped = !req.adminUser.is_super;
  const params = scoped ? [req.userId] : [];
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender='partner' AND m.read_by_admin=0) AS unread_messages,
      (SELECT email FROM users a WHERE a.id = u.referred_by) AS referred_by_email
    FROM users u
    WHERE u.role='partner' ${scoped ? 'AND u.referred_by = ?' : ''}
    ORDER BY u.id DESC
  `).all(...params);
  res.json(rows.map(serializePartner));
});

function loadOwnedPartner(req) {
  const u = db.prepare(`SELECT * FROM users WHERE id=? AND role='partner'`).get(req.params.id);
  if (!u) return null;
  if (!req.adminUser.is_super && u.referred_by !== req.userId) return 'forbidden';
  return u;
}

router.get('/partners/:id', (req, res) => {
  const u = loadOwnedPartner(req);
  if (u === 'forbidden') return res.status(403).json({ error: 'This partner is not assigned to you.' });
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  const activity = db.prepare('SELECT message, created_at FROM activity_log WHERE user_id=? ORDER BY id DESC LIMIT 25').all(u.id);
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 25').all(u.id);
  res.json({ ...serializePartner(u), activity, transactions });
});

router.post('/partners/:id/credit', (req, res) => {
  const u = loadOwnedPartner(req);
  if (u === 'forbidden') return res.status(403).json({ error: 'This partner is not assigned to you.' });
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  const amt = Number(req.body && req.body.amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amt, u.id);
  db.prepare('INSERT INTO transactions (user_id, type, amount, method, status) VALUES (?,?,?,?,?)')
    .run(u.id, 'credit', amt, 'Manual credit', 'credited');
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, `Admin credited $${amt.toFixed(2)}`);
  res.json({ ok: true });
});

router.post('/partners/:id/reset-password', (req, res) => {
  const u = loadOwnedPartner(req);
  if (u === 'forbidden') return res.status(403).json({ error: 'This partner is not assigned to you.' });
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  const tempPassword = crypto.randomBytes(5).toString('hex');
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, 'Admin reset password');
  res.json({ ok: true, tempPassword });
});

router.put('/partners/:id/status', (req, res) => {
  const u = loadOwnedPartner(req);
  if (u === 'forbidden') return res.status(403).json({ error: 'This partner is not assigned to you.' });
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  const { status } = req.body || {};
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  db.prepare(`UPDATE users SET status=? WHERE id=?`).run(status, u.id);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, `Admin set status to ${status}`);
  res.json({ ok: true });
});

router.get('/payouts', (req, res) => {
  const where = req.adminUser.is_super ? '' : 'AND u.referred_by = ?';
  const params = req.adminUser.is_super ? [] : [req.userId];
  const rows = db.prepare(`
    SELECT t.*, u.first_name, u.last_name, u.email
    FROM transactions t JOIN users u ON u.id = t.user_id
    WHERE t.type='payout' AND t.status='processing' ${where}
    ORDER BY t.id ASC
  `).all(...params);
  res.json(rows);
});

router.post('/transactions/:id/settle', (req, res) => {
  const { action } = req.body || {}; // 'paid' | 'reject'
  const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  if (!req.adminUser.is_super) {
    const owner = db.prepare('SELECT referred_by FROM users WHERE id=?').get(tx.user_id);
    if (!owner || owner.referred_by !== req.userId) return res.status(403).json({ error: 'This partner is not assigned to you.' });
  }
  if (tx.type !== 'payout' || tx.status !== 'processing') {
    return res.status(400).json({ error: 'Only pending payout requests can be settled.' });
  }
  if (action === 'paid') {
    db.prepare(`UPDATE transactions SET status='paid' WHERE id=?`).run(tx.id);
    db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(tx.user_id, `Payout of $${Math.abs(tx.amount).toFixed(2)} marked as paid`);
  } else if (action === 'reject') {
    db.prepare(`UPDATE transactions SET status='rejected' WHERE id=?`).run(tx.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(Math.abs(tx.amount), tx.user_id);
    db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(tx.user_id, 'Payout request rejected, funds returned to balance');
  } else {
    return res.status(400).json({ error: 'Invalid action.' });
  }
  res.json({ ok: true });
});

// ---------- messages (support chat with a partner) ----------
router.get('/partners/:id/messages', (req, res) => {
  const u = loadOwnedPartner(req);
  if (u === 'forbidden') return res.status(403).json({ error: 'This partner is not assigned to you.' });
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  const rows = db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY id ASC').all(req.params.id);
  db.prepare(`UPDATE messages SET read_by_admin=1 WHERE user_id=? AND sender='partner' AND read_by_admin=0`).run(req.params.id);
  res.json(rows);
});

router.post('/partners/:id/messages', (req, res) => {
  const u = loadOwnedPartner(req);
  if (u === 'forbidden') return res.status(403).json({ error: 'This partner is not assigned to you.' });
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  const info = db.prepare(`INSERT INTO messages (user_id, sender, body) VALUES (?, 'admin', ?)`).run(req.params.id, String(body).trim());
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(req.params.id, 'Received a message from support');
  res.json({ id: info.lastInsertRowid });
});

// ---------- admin accounts (super-admin only) ----------
function requireSuper(req, res, next) {
  if (!req.adminUser.is_super) return res.status(403).json({ error: 'Only a super-admin can do this.' });
  next();
}

router.get('/admins', requireSuper, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM users p WHERE p.referred_by = a.id) AS partner_count
    FROM users a WHERE a.role='admin' ORDER BY a.id ASC
  `).all();
  res.json(rows.map(a => ({
    id: a.id, firstName: a.first_name, lastName: a.last_name, email: a.email,
    isSuper: !!a.is_super, refCode: a.ref_code, partnerCount: a.partner_count, createdAt: a.created_at
  })));
});

router.post('/admins', requireSuper, (req, res) => {
  const { firstName, email, password } = req.body || {};
  if (!firstName || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
  const hash = bcrypt.hashSync(password, 10);
  const refCode = crypto.randomBytes(4).toString('hex');
  const info = db.prepare(`INSERT INTO users (role, first_name, email, password_hash, ref_code) VALUES ('admin',?,?,?,?)`)
    .run(String(firstName).trim(), String(email).toLowerCase(), hash, refCode);
  res.json({ id: info.lastInsertRowid, refCode });
});

router.delete('/admins/:id', requireSuper, (req, res) => {
  if (Number(req.params.id) === req.userId) return res.status(400).json({ error: "You can't delete your own account." });
  const target = db.prepare(`SELECT * FROM users WHERE id=? AND role='admin'`).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found.' });
  // unassign their partners rather than leaving a dangling reference
  db.prepare('UPDATE users SET referred_by=NULL WHERE referred_by=?').run(target.id);
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  res.json({ ok: true });
});

// ---------- offers ----------
function serializeOffer(o) {
  return {
    id: o.id, name: o.name, geo: o.geo, model: o.model, conversion: o.conversion || '', status: o.status,
    connected: !!o.connected, downloadUrl: o.download_url || '',
    fileName: o.file_name || '', hasFile: !!o.file_path
  };
}

router.get('/offers', (req, res) => {
  const rows = db.prepare('SELECT * FROM offers ORDER BY rowid DESC').all();
  res.json(rows.map(serializeOffer));
});

router.post('/offers', (req, res) => {
  const { name, geo, model, conversion, status } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  const id = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + crypto.randomBytes(2).toString('hex');
  db.prepare('INSERT INTO offers (id, name, geo, model, conversion, status) VALUES (?,?,?,?,?,?)')
    .run(id, String(name).trim(), geo || '', model || '', conversion || '', status === 'paused' ? 'paused' : 'active');
  res.json(serializeOffer(db.prepare('SELECT * FROM offers WHERE id=?').get(id)));
});

router.put('/offers/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM offers WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  const { name, geo, model, conversion, status, downloadUrl } = req.body || {};
  const finalUrl = downloadUrl != null ? downloadUrl : o.download_url;
  db.prepare(`UPDATE offers SET name=?, geo=?, model=?, conversion=?, status=?, connected=?, download_url=? WHERE id=?`).run(
    name != null ? String(name).trim() : o.name,
    geo != null ? geo : o.geo,
    model != null ? model : o.model,
    conversion != null ? conversion : o.conversion,
    status === 'paused' ? 'paused' : 'active',
    (finalUrl || o.file_path) ? 1 : 0,
    finalUrl,
    o.id
  );
  res.json(serializeOffer(db.prepare('SELECT * FROM offers WHERE id=?').get(o.id)));
});

router.delete('/offers/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM offers WHERE id=?').get(req.params.id);
  if (o && o.file_path) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, o.file_path)); } catch (e) {}
  }
  db.prepare('DELETE FROM offers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/offers/:id/file', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    const o = db.prepare('SELECT * FROM offers WHERE id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    if (o.file_path) { try { fs.unlinkSync(path.join(UPLOADS_DIR, o.file_path)); } catch (e) {} }
    db.prepare('UPDATE offers SET file_path=?, file_name=?, connected=1 WHERE id=?')
      .run(req.file.filename, req.file.originalname, o.id);
    res.json(serializeOffer(db.prepare('SELECT * FROM offers WHERE id=?').get(o.id)));
  });
});

router.delete('/offers/:id/file', (req, res) => {
  const o = db.prepare('SELECT * FROM offers WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.file_path) { try { fs.unlinkSync(path.join(UPLOADS_DIR, o.file_path)); } catch (e) {} }
  db.prepare('UPDATE offers SET file_path=?, file_name=? WHERE id=?').run('', '', o.id);
  res.json(serializeOffer(db.prepare('SELECT * FROM offers WHERE id=?').get(o.id)));
});

module.exports = router;

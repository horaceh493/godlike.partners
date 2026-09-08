const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { getSettings, setSettings } = require('../utils/settings');
const { slugify, generateUniqueSlug } = require('../utils/slug');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function currentAdmin(req) {
  return db.prepare('SELECT * FROM users WHERE id=? AND role=\'admin\'').get(req.userId);
}

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
    ownerAdminId: u.owner_admin_id || null,
    ownerAdminName: u.owner_first_name || null
  };
}

// Regular admins only ever see/manage the partners assigned to them.
// The super admin sees everyone and can reassign ownership.
router.get('/partners', (req, res) => {
  const me = currentAdmin(req);
  const rows = me.is_super_admin
    ? db.prepare(`
        SELECT u.*,
          (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender='partner' AND m.read_by_admin=0) AS unread_messages,
          a.first_name AS owner_first_name
        FROM users u LEFT JOIN users a ON a.id = u.owner_admin_id
        WHERE u.role='partner' ORDER BY u.id DESC
      `).all()
    : db.prepare(`
        SELECT u.*,
          (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender='partner' AND m.read_by_admin=0) AS unread_messages,
          a.first_name AS owner_first_name
        FROM users u LEFT JOIN users a ON a.id = u.owner_admin_id
        WHERE u.role='partner' AND u.owner_admin_id=? ORDER BY u.id DESC
      `).all(req.userId);
  res.json(rows.map(serializePartner));
});

router.get('/partners/:id', (req, res) => {
  const me = currentAdmin(req);
  const u = db.prepare(`SELECT * FROM users WHERE id=? AND role='partner'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  if (!me.is_super_admin && u.owner_admin_id !== me.id) {
    return res.status(403).json({ error: 'This partner is assigned to another admin.' });
  }
  const activity = db.prepare('SELECT message, created_at FROM activity_log WHERE user_id=? ORDER BY id DESC LIMIT 25').all(u.id);
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 25').all(u.id);
  res.json({ ...serializePartner(u), activity, transactions });
});

// Reassign which admin manages a partner. Super admin only.
router.put('/partners/:id/owner', requireSuperAdmin, (req, res) => {
  const { adminId } = req.body || {};
  const u = db.prepare(`SELECT id FROM users WHERE id=? AND role='partner'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  let newOwnerId = null;
  if (adminId) {
    const admin = db.prepare(`SELECT id FROM users WHERE id=? AND role='admin'`).get(adminId);
    if (!admin) return res.status(400).json({ error: 'Admin not found.' });
    newOwnerId = admin.id;
  }
  db.prepare('UPDATE users SET owner_admin_id=? WHERE id=?').run(newOwnerId, u.id);
  res.json({ ok: true });
});

// A regular admin may only act on the partners assigned to them; the super
// admin can act on anyone. Returns the partner row, or null after already
// sending an error response.
function loadPartnerInScope(req, res) {
  const me = currentAdmin(req);
  const u = db.prepare(`SELECT * FROM users WHERE id=? AND role='partner'`).get(req.params.id);
  if (!u) { res.status(404).json({ error: 'Partner not found.' }); return null; }
  if (!me.is_super_admin && u.owner_admin_id !== me.id) {
    res.status(403).json({ error: 'This partner is assigned to another admin.' });
    return null;
  }
  return u;
}

router.post('/partners/:id/credit', (req, res) => {
  const amt = Number(req.body && req.body.amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amt, u.id);
  db.prepare('INSERT INTO transactions (user_id, type, amount, method, status) VALUES (?,?,?,?,?)')
    .run(u.id, 'credit', amt, 'Manual credit', 'credited');
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, `Admin credited $${amt.toFixed(2)}`);
  res.json({ ok: true });
});

router.post('/partners/:id/reset-password', (req, res) => {
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  const tempPassword = crypto.randomBytes(5).toString('hex');
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, 'Admin reset password');
  // MVP: return the temp password once so the admin can relay it manually.
  // In production, email a reset link instead of returning the password in the API response.
  res.json({ ok: true, tempPassword });
});

router.put('/partners/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  db.prepare(`UPDATE users SET status=? WHERE id=?`).run(status, u.id);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, `Admin set status to ${status}`);
  res.json({ ok: true });
});

router.get('/payouts', (req, res) => {
  const me = currentAdmin(req);
  const rows = me.is_super_admin
    ? db.prepare(`
        SELECT t.*, u.first_name, u.last_name, u.email
        FROM transactions t JOIN users u ON u.id = t.user_id
        WHERE t.type='payout' AND t.status='processing'
        ORDER BY t.id ASC
      `).all()
    : db.prepare(`
        SELECT t.*, u.first_name, u.last_name, u.email
        FROM transactions t JOIN users u ON u.id = t.user_id
        WHERE t.type='payout' AND t.status='processing' AND u.owner_admin_id=?
        ORDER BY t.id ASC
      `).all(req.userId);
  res.json(rows);
});

router.post('/transactions/:id/settle', (req, res) => {
  const { action } = req.body || {}; // 'paid' | 'reject'
  const me = currentAdmin(req);
  const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  if (!me.is_super_admin) {
    const owner = db.prepare('SELECT owner_admin_id FROM users WHERE id=?').get(tx.user_id);
    if (!owner || owner.owner_admin_id !== me.id) return res.status(403).json({ error: 'This partner is assigned to another admin.' });
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

router.get('/partners/:id/messages', (req, res) => {
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  const rows = db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY id ASC').all(u.id);
  db.prepare(`UPDATE messages SET read_by_admin=1 WHERE user_id=? AND sender='partner' AND read_by_admin=0`).run(u.id);
  res.json(rows);
});

router.post('/partners/:id/messages', (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  const info = db.prepare(`INSERT INTO messages (user_id, sender, body) VALUES (?, 'admin', ?)`).run(u.id, String(body).trim());
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, 'Received a message from support');
  res.json({ id: info.lastInsertRowid });
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

// ---------- admin management (super admin only) ----------
function serializeAdmin(u) {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    email: u.email,
    status: u.status,
    isSuperAdmin: !!u.is_super_admin,
    createdAt: u.created_at,
    partnerCount: u.partner_count || 0,
    refSlug: u.ref_slug || ''
  };
}

router.get('/admins', requireSuperAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM users p WHERE p.owner_admin_id = u.id) AS partner_count
    FROM users u WHERE u.role='admin' ORDER BY u.is_super_admin DESC, u.id ASC
  `).all();
  res.json(rows.map(serializeAdmin));
});

router.post('/admins', requireSuperAdmin, (req, res) => {
  const { firstName, email, password } = req.body || {};
  if (!firstName || !String(firstName).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!email || !String(email).trim()) return res.status(400).json({ error: 'Email is required.' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
  const hash = bcrypt.hashSync(password, 10);
  const slug = generateUniqueSlug(String(firstName).trim());
  const info = db.prepare(`
    INSERT INTO users (role, first_name, email, password_hash, is_super_admin, ref_slug) VALUES ('admin', ?, ?, ?, 0, ?)
  `).run(String(firstName).trim(), normalizedEmail, hash, slug);
  res.json(serializeAdmin(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)));
});

router.put('/admins/:id/status', requireSuperAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const target = db.prepare(`SELECT * FROM users WHERE id=? AND role='admin'`).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found.' });
  if (target.is_super_admin) return res.status(400).json({ error: 'The main admin cannot be blocked.' });
  db.prepare(`UPDATE users SET status=? WHERE id=?`).run(status, target.id);
  res.json({ ok: true });
});

// Lets the super admin pick a nicer alias for an admin's referral link
// (e.g. "anna" instead of an auto-generated one). Falls back to a slugified
// version of whatever they typed, and still guarantees uniqueness.
router.put('/admins/:id/slug', requireSuperAdmin, (req, res) => {
  const { slug } = req.body || {};
  const target = db.prepare(`SELECT * FROM users WHERE id=? AND role='admin'`).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found.' });
  if (!slug || !String(slug).trim()) return res.status(400).json({ error: 'Alias cannot be empty.' });
  const cleaned = slugify(String(slug).trim());
  const clash = db.prepare('SELECT id FROM users WHERE ref_slug=? AND id != ?').get(cleaned, target.id);
  if (clash) return res.status(409).json({ error: 'This alias is already taken by another manager.' });
  db.prepare('UPDATE users SET ref_slug=? WHERE id=?').run(cleaned, target.id);
  res.json(serializeAdmin(db.prepare('SELECT * FROM users WHERE id=?').get(target.id)));
});

// ---------- site settings: dashboard banner + pre-withdrawal notice ----------
const BANNER_UPLOADS_DIR = path.join(db.DATA_DIR, 'uploads');
const bannerUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BANNER_UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, 'banner-' + crypto.randomBytes(16).toString('hex') + safeExt);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB, plenty for a banner image
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Only image files are allowed (png, jpg, webp, gif, svg).'));
    cb(null, true);
  }
});

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.put('/settings', requireSuperAdmin, (req, res) => {
  const updated = setSettings(req.body || {});
  res.json(updated);
});

router.post('/settings/banner-image', requireSuperAdmin, (req, res) => {
  bannerUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const url = '/uploads/' + req.file.filename;
    const updated = setSettings({ banner_image_url: url });
    res.json({ url, settings: updated });
  });
});

module.exports = router;

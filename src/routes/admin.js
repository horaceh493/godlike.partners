const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { getSettings, setSettings } = require('../utils/settings');
const { teamIds, canManagePartner, payoutConfig, dateInZone, isValidDate, REPORT_TIMEZONE, audit } = require('../utils/team');
const { assignOwner } = require('../utils/ownership');

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.use((req, res, next) => {
  for (const key of ['date','from','to']) {
    const value = req.method === 'GET' ? req.query[key] : req.body?.[key];
    if (value !== undefined && value !== '' && !isValidDate(value)) return res.status(400).json({ error: 'Некорректная дата. Используйте ГГГГ-ММ-ДД.' });
  }
  next();
});
// Log only successful writes; never log request bodies, secrets or amounts.
router.use((req, res, next) => {
  if (['POST','PUT','DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400) audit(req.userId, req.method + ' ' + (req.route?.path || req.path), req.auditTarget || req.params?.id || '');
    });
  }
  next();
});
router.use(require('./team-admins'));
router.use(require('./telegram-settings'));

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
    ownerAdminName: u.owner_first_name || null,
    noticeOverride: !!u.notice_override,
    noticeEnabled: !!u.notice_enabled,
    noticeTitle: u.notice_title || '',
    noticeBody: u.notice_body || '',
    noticeUrl: u.notice_url || '',
    announceOverride: !!u.announce_override,
    announceEnabled: !!u.announce_enabled,
    announceTitle: u.announce_title || '',
    announceBody: u.announce_body || '',
    announceBtnLabel: u.announce_btn_label || '',
    announceBtnUrl: u.announce_btn_url || ''
  };
}

// Regular admins only ever see/manage the partners assigned to them.
// The super admin sees everyone and can reassign ownership.
router.get('/partners', (req, res) => {
  const me = currentAdmin(req);
  const ids = teamIds(me);
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id=u.id AND m.sender='partner' AND m.read_by_admin=0) AS unread_messages,
      a.first_name AS owner_first_name
    FROM users u LEFT JOIN users a ON a.id=u.owner_admin_id
    WHERE u.role='partner' ORDER BY u.id DESC
  `).all().filter(u => me.is_super_admin || ids.includes(u.owner_admin_id));
  res.json(rows.map(serializePartner));
});

// Exact-email lookup exposes only a minimal preview of unassigned accounts.
router.get('/partners/unassigned', (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Введите полный email регистрации партнёра.'});
  const p = db.prepare("SELECT id,first_name,last_name,email FROM users WHERE role='partner' AND email=? AND owner_admin_id IS NULL").get(email);
  if (!p) return res.status(404).json({error:'Незакреплённый партнёр с таким email не найден. Проверьте email; если он уже назначен, откройте карточку своей команды или обратитесь к главному админу.'});
  res.json({id:p.id,firstName:p.first_name,lastName:p.last_name,email:p.email});
});

router.post('/partners/claim', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Введите полный email регистрации партнёра.'});
  const p = db.prepare("SELECT id FROM users WHERE role='partner' AND email=?").get(email);
  if (!p) return res.status(404).json({error:'Партнёр не найден. Сначала он должен зарегистрироваться.'});
  try {
    const result = assignOwner(req.authUser,p.id,req.body.adminId,true);
    req.auditTarget = p.id;
    res.json(result);
  } catch (error) { if (error.status) return res.status(error.status).json({error:error.message}); throw error; }
});

router.get('/partners/:id', (req, res) => {
  const me = currentAdmin(req);
  const u = db.prepare(`SELECT * FROM users WHERE id=? AND role='partner'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Partner not found.' });
  if (!canManagePartner(me, u)) {
    return res.status(403).json({ error: 'This partner is assigned to another admin.' });
  }
  const activity = db.prepare('SELECT message, created_at FROM activity_log WHERE user_id=? ORDER BY id DESC LIMIT 25').all(u.id);
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 25').all(u.id);
  const payoutUrls = payoutConfig(u.owner_admin_id).urls;
  const ownerHistory = me.is_super_admin ? db.prepare(`SELECT h.id,h.created_at AS createdAt,h.reason,
    a.first_name AS actorName,f.first_name AS fromName,t.first_name AS toName
    FROM partner_owner_history h LEFT JOIN users a ON a.id=h.actor_id
    LEFT JOIN users f ON f.id=h.from_admin_id LEFT JOIN users t ON t.id=h.to_admin_id
    WHERE h.partner_id=? ORDER BY h.id DESC LIMIT 30`).all(u.id) : undefined;
  res.json({ ...serializePartner(u), activity, transactions, payoutUrls, payoutUrl: payoutUrls.includes(u.payout_method_url) ? u.payout_method_url : '', ...(me.is_super_admin ? {ownerHistory} : {}) });
});

// Leads can move partners inside their subtree; only the main admin can
// move them between unrelated teams or clear ownership.
router.put('/partners/:id/owner', (req, res) => {
  try { res.json(assignOwner(req.authUser,req.params.id,req.body?.adminId)); }
  catch (error) { if (error.status) return res.status(error.status).json({error:error.message}); throw error; }
});

// A regular admin may only act on the partners assigned to them; the super
// admin can act on anyone. Returns the partner row, or null after already
// sending an error response.
function loadPartnerInScope(req, res) {
  const me = currentAdmin(req);
  const u = db.prepare(`SELECT * FROM users WHERE id=? AND role='partner'`).get(req.params.id);
  if (!u) { res.status(404).json({ error: 'Partner not found.' }); return null; }
  if (!canManagePartner(me, u)) {
    res.status(403).json({ error: 'This partner is assigned to another admin.' });
    return null;
  }
  return u;
}

router.post('/partners/:id/credit', (req, res) => {
  const amt = Number(req.body && req.body.amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
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
  db.prepare('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?').run(hash, u.id);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(u.id, 'Admin reset password');
  // MVP: return the temp password once so the admin can relay it manually.
  // In production, email a reset link instead of returning the password in the API response.
  res.json({ ok: true, tempPassword });
});

// Lets this partner's own manager (or the super admin) give them a custom
// pre-withdrawal notice instead of the site-wide one. `override:false` clears
// it and the partner falls back to the global setting again.
router.put('/partners/:id/notice-override', (req, res) => {
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  const { override, enabled, title, body, url } = req.body || {};
  db.prepare(`
    UPDATE users SET notice_override=?, notice_enabled=?, notice_title=?, notice_body=?, notice_url=? WHERE id=?
  `).run(override ? 1 : 0, enabled ? 1 : 0, title || '', body || '', url || '', u.id);
  res.json(serializePartner(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
});

// Same idea for the big entry-announcement popup, scoped to one partner.
router.put('/partners/:id/announcement-override', (req, res) => {
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  const { override, enabled, title, body, buttonLabel, buttonUrl } = req.body || {};
  db.prepare(`
    UPDATE users SET announce_override=?, announce_enabled=?, announce_title=?, announce_body=?, announce_btn_label=?, announce_btn_url=? WHERE id=?
  `).run(override ? 1 : 0, enabled ? 1 : 0, title || '', body || '', buttonLabel || '', buttonUrl || '', u.id);
  res.json(serializePartner(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
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

// Permanently deletes a partner and everything tied to them (transactions,
// payment methods, links, messages, activity log all cascade via FK). Scoped
// like every other partner-mutating route: a regular admin can only delete
// their own partners, the super admin can delete anyone.
router.delete('/partners/:id', (req, res) => {
  const u = loadPartnerInScope(req, res);
  if (!u) return;
  db.prepare(`DELETE FROM users WHERE id=? AND role='partner'`).run(u.id);
  res.json({ ok: true });
});

router.get('/payouts', (req, res) => {
  const me = currentAdmin(req);
  const ids = teamIds(me);
  const rows = db.prepare(`SELECT t.*,u.first_name,u.last_name,u.email,u.owner_admin_id
    FROM transactions t JOIN users u ON u.id=t.user_id
    WHERE t.type='payout' AND t.status='processing' ORDER BY t.id`).all()
    .filter(u => me.is_super_admin || ids.includes(u.owner_admin_id));
  res.json(rows);
});

router.post('/transactions/:id/settle', (req, res) => {
  const { action } = req.body || {}; // 'paid' | 'reject'
  const me = currentAdmin(req);
  const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  if (!me.is_super_admin) {
    const owner = db.prepare('SELECT * FROM users WHERE id=?').get(tx.user_id);
    if (!canManagePartner(me, owner)) return res.status(403).json({ error: 'This partner is assigned to another admin.' });
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

// ---------- profit split rules ----------
// What a partner "paid out" gets split three ways. The manager who logged
// the entry always keeps half. Above $50, a fixed 20% is set aside for
// payment-gateway costs and the owner keeps the other 30%; at or below $50
// there's no automatic gateway cut, so the owner keeps 50% instead. A
// manual, optional per-entry expense (e.g. a proxy/SIM cost tied to that
// one partner) is then subtracted from the owner's share -- it defaults to
// 0, i.e. nothing is deducted unless someone fills it in.
const GATEWAY_THRESHOLD = 50;
const GATEWAY_RATE = 0.20;
const MANAGER_RATE = 0.50;

function splitAmount(amount, expense) {
  const amt = Number(amount) || 0;
  const exp = Number(expense) || 0;
  const managerShare = amt * MANAGER_RATE;
  const gatewayCost = amt > GATEWAY_THRESHOLD ? amt * GATEWAY_RATE : 0;
  const ownerGross = amt - managerShare - gatewayCost; // 30% above the threshold, 50% at/below it
  const ownerNet = ownerGross - exp;
  return { managerShare, gatewayCost, ownerGross, ownerNet };
}

// ---------- manager's own daily report (Telegram posts, groups created, partner profit ledger) ----------
function todayStr() {
  return dateInZone();
}
function isValidDateStr(s) {
  return isValidDate(s);
}

function serializeProfitEntry(e, includeFinancials = false) {
  const safe = { id: e.id, adminId: e.admin_id, date: e.entry_date,
    partnerTg: e.partner_tg, amount: e.amount, createdAt: e.created_at };
  return includeFinancials ? { ...safe, expenseAmount: e.expense_amount || 0, ...splitAmount(e.amount, e.expense_amount) } : safe;
}

// Every admin (regular manager or super admin) reports on themselves here --
// there is no scoping check beyond "this is my own row", req.userId is always
// the actor.
router.get('/report/activity', (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : todayStr();
  const row = db.prepare('SELECT * FROM admin_daily_activity WHERE admin_id=? AND activity_date=?').get(req.userId, date);
  res.json({ date, tgPosts: row ? row.tg_posts : 0, groupsCreated: row ? row.groups_created : 0 });
});

router.put('/report/activity', (req, res) => {
  const { date, tgPosts, groupsCreated } = req.body || {};
  const d = isValidDateStr(date) ? date : todayStr();
  const tg = Number(tgPosts);
  const groups = Number(groupsCreated);
  if (![tg,groups].every(n => Number.isSafeInteger(n) && n >= 0)) return res.status(400).json({ error: 'Укажите целые неотрицательные количества.' });
  db.prepare(`
    INSERT INTO admin_daily_activity (admin_id, activity_date, tg_posts, groups_created, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(admin_id, activity_date) DO UPDATE SET tg_posts=excluded.tg_posts, groups_created=excluded.groups_created, updated_at=datetime('now')
  `).run(req.userId, d, tg, groups);
  res.json({ date: d, tgPosts: tg, groupsCreated: groups });
});

// The profit ledger: partner Telegram handle + amount that came out of them.
// Every entry ever logged (by this admin) counts toward their total earning
// (sum / 2) regardless of date; `date` just filters which entries are shown.
router.get('/report/profit', (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : null;
  const entries = date
    ? db.prepare('SELECT * FROM admin_profit_entries WHERE admin_id=? AND entry_date=? ORDER BY id DESC').all(req.userId, date)
    : db.prepare('SELECT * FROM admin_profit_entries WHERE admin_id=? ORDER BY id DESC').all(req.userId);
  const totalAll = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM admin_profit_entries WHERE admin_id=?').get(req.userId).s;
  res.json({
    entries: entries.map(e => serializeProfitEntry(e, !!req.authUser.is_super_admin)),
    dayTotal: entries.reduce((sum, e) => sum + e.amount, 0),
    totalAll,
    earning: totalAll / 2
  });
});

router.post('/report/profit', (req, res) => {
  const { partnerTg, amount, date, expenseAmount } = req.body || {};
  const amt = Number(amount);
  if (!partnerTg || !String(partnerTg).trim()) return res.status(400).json({ error: 'Enter the partner\'s Telegram.' });
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  if (expenseAmount !== undefined && !req.authUser.is_super_admin) return res.status(403).json({ error: 'Расходы доступны только главному админу.' });
  const exp = expenseAmount === undefined ? 0 : Number(expenseAmount);
  if (!Number.isFinite(exp) || exp < 0) return res.status(400).json({ error: 'Некорректный расход.' });
  const d = isValidDateStr(date) ? date : todayStr();
  const info = db.prepare('INSERT INTO admin_profit_entries (admin_id, entry_date, partner_tg, amount, expense_amount) VALUES (?,?,?,?,?)')
    .run(req.userId, d, String(partnerTg).trim(), amt, exp);
  res.json(serializeProfitEntry(db.prepare('SELECT * FROM admin_profit_entries WHERE id=?').get(info.lastInsertRowid), !!req.authUser.is_super_admin));
});

// A manager can fix their own entry; the super admin can fix anyone's --
// this is the "I can edit the amount" control the main admin asked for.
router.put('/report/profit/:id', (req, res) => {
  const me = currentAdmin(req);
  const entry = db.prepare('SELECT * FROM admin_profit_entries WHERE id=?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (!me.is_super_admin && entry.admin_id !== req.userId) return res.status(403).json({ error: 'Not your entry.' });
  const { partnerTg, amount, expenseAmount } = req.body || {};
  const amt = amount === undefined ? entry.amount : Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Invalid amount.' });
  const tg = partnerTg === undefined ? entry.partner_tg : String(partnerTg).trim();
  if (expenseAmount !== undefined && !me.is_super_admin) return res.status(403).json({ error: 'Расходы доступны только главному админу.' });
  const exp = expenseAmount === undefined ? entry.expense_amount : Number(expenseAmount);
  if (!Number.isFinite(exp) || exp < 0) return res.status(400).json({ error: 'Некорректный расход.' });
  db.prepare('UPDATE admin_profit_entries SET partner_tg=?, amount=?, expense_amount=? WHERE id=?').run(tg, amt, exp, entry.id);
  res.json(serializeProfitEntry(db.prepare('SELECT * FROM admin_profit_entries WHERE id=?').get(entry.id), !!me.is_super_admin));
});

router.delete('/report/profit/:id', (req, res) => {
  const me = currentAdmin(req);
  const entry = db.prepare('SELECT * FROM admin_profit_entries WHERE id=?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (!me.is_super_admin && entry.admin_id !== req.userId) return res.status(403).json({ error: 'Not your entry.' });
  db.prepare('DELETE FROM admin_profit_entries WHERE id=?').run(entry.id);
  res.json({ ok: true });
});

// ---------- finance: company-wide expenses + owner dashboard ----------
// Costs not tied to any specific partner (electricity, hosting, proxies...).
// Super admin only, since this is the owner's own P&L view.
function serializeExpense(e) {
  return { id: e.id, date: e.expense_date, label: e.label || '', amount: e.amount, note: e.note || '', adminId: e.admin_id || null, adminName: e.admin_id ? db.prepare('SELECT first_name FROM users WHERE id=?').get(e.admin_id)?.first_name : '', createdAt: e.created_at };
}

router.get('/finance/expenses', requireSuperAdmin, (req, res) => {
  const { from, to } = req.query || {};
  const rows = (isValidDateStr(from) && isValidDateStr(to))
    ? db.prepare('SELECT * FROM company_expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC').all(from, to)
    : db.prepare('SELECT * FROM company_expenses ORDER BY expense_date DESC, id DESC LIMIT 200').all();
  res.json(rows.map(serializeExpense));
});

router.post('/finance/expenses', requireSuperAdmin, (req, res) => {
  const { date, label, amount, note, adminId } = req.body || {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  const d = isValidDateStr(date) ? date : todayStr();
  const owner = adminId ? db.prepare("SELECT id FROM users WHERE id=? AND role='admin'").get(adminId) : null;
  if (adminId && !owner) return res.status(400).json({ error: 'Менеджер не найден.' });
  const info = db.prepare('INSERT INTO company_expenses (expense_date, label, amount, note, created_by, admin_id) VALUES (?,?,?,?,?,?)')
    .run(d, label ? String(label).trim() : '', amt, note ? String(note).trim() : '', req.userId, owner?.id || null);
  res.json(serializeExpense(db.prepare('SELECT * FROM company_expenses WHERE id=?').get(info.lastInsertRowid)));
});

router.put('/finance/expenses/:id', requireSuperAdmin, (req, res) => {
  const e = db.prepare('SELECT * FROM company_expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Expense not found.' });
  const { date, label, amount, note, adminId } = req.body || {};
  const amt = amount === undefined ? e.amount : Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Invalid amount.' });
  const ownerId = adminId === undefined ? e.admin_id : (adminId || null);
  if (ownerId && !db.prepare("SELECT id FROM users WHERE id=? AND role='admin'").get(ownerId)) return res.status(400).json({ error: 'Менеджер не найден.' });
  db.prepare('UPDATE company_expenses SET expense_date=?, label=?, amount=?, note=?, admin_id=? WHERE id=?').run(
    isValidDateStr(date) ? date : e.expense_date,
    label !== undefined ? String(label).trim() : e.label,
    amt,
    note !== undefined ? String(note).trim() : e.note,
    ownerId,
    e.id
  );
  res.json(serializeExpense(db.prepare('SELECT * FROM company_expenses WHERE id=?').get(e.id)));
});

router.delete('/finance/expenses/:id', requireSuperAdmin, (req, res) => {
  const e = db.prepare('SELECT * FROM company_expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Expense not found.' });
  db.prepare('DELETE FROM company_expenses WHERE id=?').run(e.id);
  res.json({ ok: true });
});

// Monday-start week in UTC, so the boundary doesn't shift with the server's
// local timezone.
function startOfWeekUTC(d) {
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diff = (day === 0 ? -6 : 1) - day;
  const res = new Date(d);
  res.setUTCDate(d.getUTCDate() + diff);
  return res;
}
function toDateStr(d) { return d.toISOString().slice(0, 10); }

// Totals for one date range (or the whole lifetime, when both are null):
// gross profit from partners, the manager cut, the gateway cut, what's left
// for the owner before/after expenses.
function periodTotals(fromDate, toDate) {
  const ranged = fromDate && toDate;
  const rows = ranged
    ? db.prepare('SELECT amount, expense_amount FROM admin_profit_entries WHERE entry_date BETWEEN ? AND ?').all(fromDate, toDate)
    : db.prepare('SELECT amount, expense_amount FROM admin_profit_entries').all();
  let gross = 0, managerShare = 0, gatewayCost = 0, entryExpenses = 0;
  for (const r of rows) {
    const s = splitAmount(r.amount, r.expense_amount);
    gross += r.amount;
    managerShare += s.managerShare;
    gatewayCost += s.gatewayCost;
    entryExpenses += r.expense_amount || 0;
  }
  const ownerGross = gross - managerShare - gatewayCost;
  const generalExpenses = ranged
    ? db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM company_expenses WHERE expense_date BETWEEN ? AND ?').get(fromDate, toDate).s
    : db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM company_expenses').get().s;
  const ownerNet = ownerGross - entryExpenses - generalExpenses;
  return { gross, managerShare, gatewayCost, ownerGross, entryExpenses, generalExpenses, ownerNet };
}

// The main "how much have we earned" panel: day / week (Mon-Sun) / month /
// all-time, each with the gross partner profit and the owner's net side by
// side, plus the breakdown that explains the gap between them.
router.get('/finance/overview', requireSuperAdmin, (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : todayStr();
  const ref = new Date(date + 'T00:00:00Z');
  const weekStart = startOfWeekUTC(ref);
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  const monthStart = date.slice(0, 7) + '-01';
  const monthEnd = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  res.json({
    date,
    day: periodTotals(date, date),
    week: periodTotals(toDateStr(weekStart), toDateStr(weekEnd)),
    month: periodTotals(monthStart, toDateStr(monthEnd)),
    allTime: periodTotals(null, null)
  });
});

// Every manager's profit entries in one place (unlike GET /report/profit,
// which only shows the logged-in admin's own entries), so the owner can see
// and correct the per-entry expense on any of them.
router.get('/finance/entries', requireSuperAdmin, (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : null;
  const rows = date
    ? db.prepare(`
        SELECT e.*, a.first_name AS admin_first_name, a.last_name AS admin_last_name
        FROM admin_profit_entries e JOIN users a ON a.id = e.admin_id
        WHERE e.entry_date=? ORDER BY e.id DESC
      `).all(date)
    : db.prepare(`
        SELECT e.*, a.first_name AS admin_first_name, a.last_name AS admin_last_name
        FROM admin_profit_entries e JOIN users a ON a.id = e.admin_id
        ORDER BY e.id DESC LIMIT 200
      `).all();
  res.json(rows.map(r => Object.assign(serializeProfitEntry(r, true), {
    adminName: [r.admin_first_name, r.admin_last_name].filter(Boolean).join(' ')
  })));
});

// Per-manager P&L is intentionally not exposed by the team report API.
router.get('/finance/managers', requireSuperAdmin, (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : null;
  const admins = db.prepare("SELECT id,first_name,last_name,email,team_lead_id FROM users WHERE role='admin' ORDER BY id").all();
  const rows = admins.map(a => {
    const entries = db.prepare('SELECT amount,expense_amount FROM admin_profit_entries WHERE admin_id=?' + (date ? ' AND entry_date=?' : '')).all(...(date ? [a.id,date] : [a.id]));
    let income = 0, managerShare = 0, gatewayCost = 0, entryExpenses = 0;
    for (const e of entries) {
      const split = splitAmount(e.amount, e.expense_amount);
      income += e.amount; managerShare += split.managerShare;
      gatewayCost += split.gatewayCost; entryExpenses += e.expense_amount;
    }
    const managerExpenses = db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM company_expenses WHERE admin_id=?' + (date ? ' AND expense_date=?' : '')).get(...(date ? [a.id,date] : [a.id])).n;
    const expenses = managerShare + gatewayCost + entryExpenses + managerExpenses;
    return { adminId:a.id, name:[a.first_name,a.last_name].filter(Boolean).join(' '), email:a.email,
      teamLeadId:a.team_lead_id || null, income, managerShare, gatewayCost, entryExpenses,
      managerExpenses, expenses, netProfit: income - expenses };
  });
  const unallocatedExpenses = db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM company_expenses WHERE admin_id IS NULL' + (date ? ' AND expense_date=?' : '')).get(...(date ? [date] : [])).n;
  const totals = rows.reduce((t,r) => ({income:t.income+r.income,expenses:t.expenses+r.expenses,netProfit:t.netProfit+r.netProfit}), {income:0,expenses:0,netProfit:0});
  res.json({ date, managers:rows, totals, unallocatedExpenses, companyNetProfit:totals.netProfit-unallocatedExpenses });
});

// ---------- super admin: daily stats across every manager ----------
// For a given day: how many new partners each manager brought in, how many of
// their partners got a balance credit that day, plus that manager's
// self-reported Telegram posts / groups created / profit ledger for that day,
// and their all-time earning (profit ledger sum / 2).
router.get('/stats/daily', (req, res) => {
  const date = isValidDateStr(req.query.date) ? req.query.date : todayStr();
  const scope = teamIds(req.authUser);
  const admins = db.prepare(`SELECT * FROM users WHERE role='admin' ORDER BY is_super_admin DESC, id ASC`).all().filter(a => scope.includes(a.id));
  const rows = admins.map(a => {
    const registrations = db.prepare(`
      SELECT COUNT(*) AS c FROM users WHERE role='partner' AND owner_admin_id=? AND report_date(created_at)=?
    `).get(a.id, date).c;
    const partnersCredited = db.prepare(`
      SELECT COUNT(DISTINCT t.user_id) AS c FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.type='credit' AND u.owner_admin_id=? AND report_date(t.created_at)=?
    `).get(a.id, date).c;
    const activity = db.prepare('SELECT * FROM admin_daily_activity WHERE admin_id=? AND activity_date=?').get(a.id, date);
    const dayEntries = db.prepare('SELECT * FROM admin_profit_entries WHERE admin_id=? AND entry_date=? ORDER BY id DESC').all(a.id, date);
    const totalAll = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM admin_profit_entries WHERE admin_id=?').get(a.id).s;
    return {
      adminId: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' '),
      email: a.email,
      isSuperAdmin: !!a.is_super_admin,
      registrations,
      partnersCredited,
      tgPosts: activity ? activity.tg_posts : 0,
      groupsCreated: activity ? activity.groups_created : 0,
      dayProfitEntries: dayEntries.map(e => serializeProfitEntry(e, !!req.authUser.is_super_admin)),
      dayProfitTotal: dayEntries.reduce((s, e) => s + e.amount, 0),
      teamLeadId: a.team_lead_id || null,
      reportSubmitted: !!activity,
      reportUpdatedAt: activity?.updated_at || null,
      actionsToday: db.prepare('SELECT COUNT(*) AS c FROM admin_audit_log WHERE admin_id=? AND report_date(created_at)=?').get(a.id, date).c,
      recentActions: db.prepare('SELECT action,target,created_at AS createdAt FROM admin_audit_log WHERE admin_id=? AND report_date(created_at)=? ORDER BY id DESC LIMIT 30').all(a.id, date),
      ...(req.authUser.is_super_admin ? { totalEarning: totalAll / 2 } : {})
    };
  });
  const ref = new Date(date + 'T00:00:00Z');
  const weekStart = startOfWeekUTC(ref);
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  const monthEnd = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  const sumProfit = (from, to) => db.prepare(`SELECT COALESCE(SUM(amount),0) AS total
    FROM admin_profit_entries WHERE admin_id IN (${scope.map(() => '?').join(',')})${from ? ' AND entry_date BETWEEN ? AND ?' : ''}`)
    .get(...scope, ...(from ? [from,to] : [])).total;
  res.json({ date, timezone: REPORT_TIMEZONE, admins: rows, profits: {
    day: sumProfit(date,date), week: sumProfit(toDateStr(weekStart),toDateStr(weekEnd)),
    month: sumProfit(date.slice(0,7)+'-01',toDateStr(monthEnd)), allTime: sumProfit(null,null)
  } });
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

router.put('/partners/:id/payout-url', (req, res) => {
  const me = currentAdmin(req);
  const p = db.prepare("SELECT * FROM users WHERE id=? AND role='partner'").get(req.params.id);
  if (!p) return res.status(404).json({error:'Partner not found.'});
  if (!canManagePartner(me, p)) return res.status(403).json({error:'Access denied.'});
  const allowed = payoutConfig(p.owner_admin_id).urls;
  const url = req.body.url || '';
  if (url && !allowed.includes(url)) return res.status(400).json({error:'Выберите ссылку своего менеджера.'});
  db.prepare('UPDATE users SET payout_method_url=? WHERE id=?').run(url, p.id);
  res.json({ok:true});
});

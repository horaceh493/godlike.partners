const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notifyOps } = require('../utils/notify');
const { getSettings } = require('../utils/settings');

const router = express.Router();
router.use(requireAuth);

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function serializeUser(u) {
  return {
    id: u.id,
    role: u.role,
    isSuperAdmin: !!u.is_super_admin,
    firstName: u.first_name,
    lastName: u.last_name,
    email: u.email,
    telegram: u.telegram,
    phone: u.phone,
    country: u.country,
    trafficSources: JSON.parse(u.traffic_sources || '[]'),
    balance: u.balance,
    tierVolume: u.tier_volume,
    status: u.status,
    createdAt: u.created_at
  };
}

router.get('/me', (req, res) => {
  const u = getUser(req.userId);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const unread = db.prepare(`SELECT COUNT(*) as c FROM messages WHERE user_id=? AND sender='admin' AND read_by_partner=0`).get(req.userId).c;
  res.json({ ...serializeUser(u), unreadMessages: unread });
});

// ---------- site settings (banner + pre-withdrawal notice), read-only here ----------
router.get('/settings', (req, res) => {
  const settings = getSettings();
  const u = getUser(req.userId);
  // If this partner's manager set their own payout-method link, it replaces
  // the site-wide default just for this partner.
  if (u && u.owner_admin_id) {
    const owner = db.prepare(`SELECT payout_method_url FROM users WHERE id=? AND role='admin'`).get(u.owner_admin_id);
    if (owner && owner.payout_method_url) settings.payout_method_url = owner.payout_method_url;
  }
  // A partner's manager can also override the withdrawal notice and the
  // entry announcement just for that one partner -- these fully replace the
  // site-wide values (not merged field-by-field) when turned on.
  if (u && u.notice_override) {
    settings.withdraw_notice_enabled = u.notice_enabled ? '1' : '0';
    settings.withdraw_notice_title = u.notice_title || '';
    settings.withdraw_notice_body = u.notice_body || '';
    settings.withdraw_notice_url = u.notice_url || '';
  }
  if (u && u.announce_override) {
    settings.announcement_enabled = u.announce_enabled ? '1' : '0';
    settings.announcement_title = u.announce_title || '';
    settings.announcement_body = u.announce_body || '';
    settings.announcement_button_label = u.announce_btn_label || '';
    settings.announcement_button_url = u.announce_btn_url || '';
  }
  res.json(settings);
});

router.put('/me', (req, res) => {
  const { firstName, lastName, phone, telegram, country, trafficSources } = req.body || {};
  db.prepare(`UPDATE users SET first_name=?, last_name=?, phone=?, telegram=?, country=?, traffic_sources=? WHERE id=?`)
    .run(firstName || '', lastName || '', phone || '', telegram || '', country || '', JSON.stringify(trafficSources || []), req.userId);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(req.userId, 'Updated profile');
  res.json(serializeUser(getUser(req.userId)));
});

router.put('/me/password', (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.userId);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(req.userId, 'Changed password');
  res.json({ ok: true });
});

// ---------- wallet ----------
router.get('/wallet', (req, res) => {
  const methods = db.prepare('SELECT * FROM payment_methods WHERE user_id=? ORDER BY id DESC').all(req.userId);
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC').all(req.userId);
  const u = getUser(req.userId);
  res.json({ balance: u.balance, methods, transactions });
});

router.post('/wallet/methods', (req, res) => {
  const { type, value } = req.body || {};
  if (!type || !value) return res.status(400).json({ error: 'Type and value are required.' });
  const info = db.prepare('INSERT INTO payment_methods (user_id, type, value) VALUES (?,?,?)').run(req.userId, type, value);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(req.userId, `Added payout method (${type})`);
  res.json({ id: info.lastInsertRowid, type, value });

  const u = getUser(req.userId);
  notifyOps(`🏦 Payout method added: ${type} · ${value}\nPartner: ${u.email}`, req, { ownerAdminId: u.owner_admin_id });
});

router.delete('/wallet/methods/:id', (req, res) => {
  db.prepare('DELETE FROM payment_methods WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

router.post('/wallet/payout', (req, res) => {
  const amt = Number(req.body && req.body.amount);
  const u = getUser(req.userId);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter an amount.' });
  if (amt < 50) return res.status(400).json({ error: 'Minimum payout is $50.' });
  if (amt > u.balance) return res.status(400).json({ error: 'Amount exceeds your available balance.' });
  const method = db.prepare('SELECT * FROM payment_methods WHERE id=? AND user_id=?').get(req.body.methodId, req.userId);
  if (!method) return res.status(400).json({ error: 'Select a valid payout method.' });

  db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(amt, req.userId);
  const info = db.prepare('INSERT INTO transactions (user_id, type, amount, method, status) VALUES (?,?,?,?,?)')
    .run(req.userId, 'payout', -amt, method.type, 'processing');
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(req.userId, `Requested payout of $${amt.toFixed(2)}`);
  res.json({ ok: true, transactionId: info.lastInsertRowid });

  notifyOps(
    `💸 Payout requested: $${amt.toFixed(2)}\n` +
    `Partner: ${u.email}\n` +
    `Method: ${method.type} · ${method.value}`,
    req,
    { ownerAdminId: u.owner_admin_id }
  );
});

// ---------- offers (read-only for partners) ----------
router.get('/offers', (req, res) => {
  const rows = db.prepare(`SELECT * FROM offers ORDER BY rowid DESC`).all();
  res.json(rows.map(o => ({
    id: o.id, name: o.name, geo: o.geo, model: o.model, conversion: o.conversion || '', status: o.status,
    connected: !!o.connected, downloadUrl: o.download_url || '',
    fileName: o.file_name || '', fileUrl: o.file_path ? ('/uploads/' + o.file_path) : ''
  })));
});

// ---------- links ----------
router.get('/links', (req, res) => {
  res.json(db.prepare('SELECT * FROM links WHERE user_id=? ORDER BY id DESC').all(req.userId));
});

router.post('/links', (req, res) => {
  const { offerId, sub1 } = req.body || {};
  if (!offerId) return res.status(400).json({ error: 'offerId is required.' });
  const url = `${req.protocol}://${req.get('host')}/go/${offerId}${sub1 ? '?sub1=' + encodeURIComponent(sub1) : ''}`;
  const info = db.prepare('INSERT INTO links (user_id, offer_id, sub1, url) VALUES (?,?,?,?)').run(req.userId, offerId, sub1 || '', url);
  res.json({ id: info.lastInsertRowid, offerId, sub1: sub1 || '', url });
});

// ---------- postbacks ----------
router.get('/postbacks', (req, res) => {
  let row = db.prepare('SELECT * FROM postback_settings WHERE user_id=?').get(req.userId);
  if (!row) {
    db.prepare('INSERT INTO postback_settings (user_id) VALUES (?)').run(req.userId);
    row = db.prepare('SELECT * FROM postback_settings WHERE user_id=?').get(req.userId);
  }
  res.json(row);
});

router.put('/postbacks', (req, res) => {
  const b = req.body || {};
  db.prepare(`
    UPDATE postback_settings SET
      registration_enabled=?, registration_url=?,
      ftd_enabled=?, ftd_url=?,
      repeat_enabled=?, repeat_url=?,
      reject_enabled=?, reject_url=?
    WHERE user_id=?
  `).run(
    b.registration_enabled ? 1 : 0, b.registration_url || '',
    b.ftd_enabled ? 1 : 0, b.ftd_url || '',
    b.repeat_enabled ? 1 : 0, b.repeat_url || '',
    b.reject_enabled ? 1 : 0, b.reject_url || '',
    req.userId
  );
  res.json({ ok: true });

  const u = getUser(req.userId);
  notifyOps(`⚙️ Postback settings updated\nPartner: ${u.email}`, req, { ownerAdminId: u.owner_admin_id });
});

// sends one real HTTP request to the partner's own configured postback URL
// with fake macro values, so they can verify their tracker receives it.
router.post('/postbacks/test', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL configured for this event yet.' });
  const testUrl = url
    .replaceAll('{click_id}', 'test_' + Date.now())
    .replaceAll('{status}', 'test')
    .replaceAll('{payout}', '10.00')
    .replaceAll('{currency}', 'USD')
    .replaceAll('{sub1}', 'test_sub1');
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(testUrl, { signal: controller.signal });
    clearTimeout(t);
    res.json({ ok: true, status: r.status });
    const u1 = getUser(req.userId);
    notifyOps(`🧪 Postback test fired\nPartner: ${u1.email}\nURL: ${testUrl}\nResult: HTTP ${r.status}`, null, { ownerAdminId: u1.owner_admin_id });
  } catch (e) {
    res.json({ ok: false, error: 'Could not reach that URL.' });
    const u2 = getUser(req.userId);
    notifyOps(`🧪 Postback test failed\nPartner: ${u2.email}\nURL: ${testUrl}\nResult: unreachable`, null, { ownerAdminId: u2.owner_admin_id });
  }
});

// ---------- messages (support chat with admin) ----------
router.get('/messages', (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY id ASC').all(req.userId);
  db.prepare(`UPDATE messages SET read_by_partner=1 WHERE user_id=? AND sender='admin' AND read_by_partner=0`).run(req.userId);
  res.json(rows);
});

router.post('/messages', (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  const info = db.prepare(`INSERT INTO messages (user_id, sender, body) VALUES (?, 'partner', ?)`).run(req.userId, String(body).trim());
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(req.userId, 'Sent a message to support');
  res.json({ id: info.lastInsertRowid });

  const u = getUser(req.userId);
  notifyOps(`💬 Message from partner: ${u.email}\n"${String(body).trim().slice(0, 300)}"`, req, { ownerAdminId: u.owner_admin_id });
});

module.exports = router;

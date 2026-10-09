const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { generateUniqueSlug, slugify } = require('../utils/slug');
const { adminById, teamIds, canManageAdmin, ownPayoutUrls, payoutConfig } = require('../utils/team');

const router = express.Router();
function serializeAdmin(u) {
  const config = payoutConfig(u.id);
  const parent = u.team_lead_id ? adminById(u.team_lead_id) : null;
  return {
    id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email,
    status: u.status, isSuperAdmin: !!u.is_super_admin, isTeamLead: true,
    createdAt: u.created_at, refSlug: u.ref_slug || '',
    teamLeadId: u.team_lead_id || null, teamLeadName: parent ? parent.first_name : 'Главный админ',
    partnerCount: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='partner' AND owner_admin_id=?").get(u.id).c,
    teamCount: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND team_lead_id=?").get(u.id).c,
    payoutMethodUrl: u.payout_method_url || '', payoutUrls: ownPayoutUrls(u),
    effectivePayoutUrls: config.urls, payoutSourceName: config.sourceName,
    payoutInherited: !ownPayoutUrls(u).length,
    hasTelegramBot: !!(u.telegram_bot_token && u.telegram_chat_id),
    telegramBotTokenMasked: u.telegram_bot_token ? '••••' + u.telegram_bot_token.slice(-6) : '',
    telegramChatId: u.telegram_chat_id || ''
  };
}

function targetInScope(req, res, allowSelf = false) {
  const target = adminById(req.params.id);
  if (!target) { res.status(404).json({ error: 'Менеджер не найден.' }); return null; }
  if (!(allowSelf && target.id === req.userId) && !canManageAdmin(req.authUser, target)) {
    res.status(403).json({ error: 'Можно управлять только менеджерами своей команды.' }); return null;
  }
  return target;
}

router.get('/admins', (req, res) => {
  const ids = new Set(teamIds(req.authUser));
  res.json(db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY is_super_admin DESC,id").all()
    .filter(u => ids.has(u.id)).map(serializeAdmin));
});

router.post('/admins', (req, res) => {
  const { firstName, email, password, teamLeadId } = req.body || {};
  if (typeof firstName !== 'string' || !firstName.trim() || firstName.length > 120) return res.status(400).json({ error: 'Укажите имя (до 120 символов).' });
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: 'Укажите корректный email.' });
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Пароль: минимум 8 символов, максимум 72 байта.' });
  let parentId = req.userId;
  if (req.authUser.is_super_admin) {
    parentId = teamLeadId ? Number(teamLeadId) : null;
    if (parentId) {
      const p = adminById(parentId);
      if (!p || p.status !== 'active') return res.status(400).json({ error: 'Выберите активного тимлида.' });
      if (p.is_super_admin) parentId = null;
    }
  } else if (teamLeadId != null && Number(teamLeadId) !== req.userId) {
    return res.status(403).json({ error: 'Нового менеджера можно добавить только в свою команду.' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email=?').get(normalizedEmail)) return res.status(409).json({ error: 'Этот email уже занят.' });
  const info = db.prepare(`INSERT INTO users(role,first_name,email,password_hash,ref_slug,team_lead_id)
    VALUES('admin',?,?,?,?,?)`).run(firstName.trim(), normalizedEmail, bcrypt.hashSync(password, 10), generateUniqueSlug(firstName.trim()), parentId);
  res.status(201).json(serializeAdmin(adminById(info.lastInsertRowid)));
});

router.put('/admins/:id/status', (req, res) => {
  const target = targetInScope(req, res); if (!target) return;
  if (!['active', 'blocked'].includes(req.body?.status)) return res.status(400).json({ error: 'Недопустимый статус.' });
  db.prepare('UPDATE users SET status=?,session_version=session_version+1 WHERE id=?').run(req.body.status, target.id);
  res.json({ ok: true });
});

router.post('/admins/:id/reset-password', (req, res) => {
  const target = targetInScope(req, res); if (!target) return;
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Пароль: минимум 8 символов, максимум 72 байта.' });
  db.prepare('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?').run(bcrypt.hashSync(password, 10), target.id);
  res.json({ ok: true });
});

router.put('/admins/:id/team-lead', requireSuperAdmin, (req, res) => {
  const target = targetInScope(req, res); if (!target) return;
  let parentId = req.body?.teamLeadId ? Number(req.body.teamLeadId) : null;
  if (parentId) {
    const parent = adminById(parentId);
    if (!parent || parent.status !== 'active') return res.status(400).json({ error: 'Выберите активного тимлида.' });
    if (teamIds(target).includes(parentId)) return res.status(400).json({ error: 'Нельзя назначить руководителем самого менеджера или его подчинённого.' });
    if (parent.is_super_admin) parentId = null;
  }
  db.prepare('UPDATE users SET team_lead_id=? WHERE id=?').run(parentId, target.id);
  res.json(serializeAdmin(adminById(target.id)));
});

router.put('/admins/:id/slug', requireSuperAdmin, (req, res) => {
  const target = adminById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Менеджер не найден.' });
  if (typeof req.body?.slug !== 'string' || !req.body.slug.trim()) return res.status(400).json({ error: 'Укажите алиас.' });
  const slug = slugify(req.body.slug.trim());
  if (!slug) return res.status(400).json({ error: 'Укажите буквы или цифры.' });
  if (db.prepare('SELECT id FROM users WHERE ref_slug=? AND id!=?').get(slug, target.id)) return res.status(409).json({ error: 'Алиас уже занят.' });
  db.prepare('UPDATE users SET ref_slug=? WHERE id=?').run(slug, target.id);
  res.json(serializeAdmin(adminById(target.id)));
});

router.put('/admins/:id/payout-url', requireSuperAdmin, (req, res) => {
  const urls = req.body?.urls;
  if (!Array.isArray(urls) || urls.length > 20 || urls.some(url => {
    try { const u = new URL(url); return typeof url !== 'string' || url.length > 2048 || u.protocol !== 'https:' || !!u.username || !!u.password; } catch { return true; }
  })) return res.status(400).json({ error: 'Укажите до 20 HTTPS-ссылок.' });
  const target = adminById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Менеджер не найден.' });
  const clean = [...new Set(urls.map(url => url.trim()))];
  db.prepare('UPDATE users SET payout_method_url=?,payout_urls=? WHERE id=?').run(clean[0] || '', JSON.stringify(clean), target.id);
  res.json(serializeAdmin(adminById(target.id)));
});

router.put('/admins/:id/telegram', (req, res) => {
  const target = targetInScope(req, res, true); if (!target) return;
  const botToken = String(req.body?.botToken || '').trim();
  const chatId = String(req.body?.chatId || '').trim();
  if ((botToken || chatId) && (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken) || !/^-?\d+$|^@[A-Za-z0-9_]{5,}$/.test(chatId))) {
    return res.status(400).json({ error: 'Укажите токен BotFather и корректный Chat ID; для сброса очистите оба поля.' });
  }
  db.prepare('UPDATE users SET telegram_bot_token=?,telegram_chat_id=? WHERE id=?').run(botToken, chatId, target.id);
  res.json(serializeAdmin(adminById(target.id)));
});

module.exports = router;

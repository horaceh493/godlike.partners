const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { canManagePartner } = require('../utils/team');
const { EVENTS, settingsFor, targetFor, sendTelegram, deliver } = require('../utils/telegram-postbacks');
const router = express.Router();

router.use('/partners/:id/telegram', (req, res, next) => {
  const partner = db.prepare("SELECT * FROM users WHERE id=? AND role='partner'").get(req.params.id);
  if (!partner) return res.status(404).json({ error: 'Партнёр не найден.' });
  if (!canManagePartner(req.authUser, partner)) return res.status(403).json({ error: 'Партнёр не входит в вашу команду.' });
  req.telegramPartner = partner;
  next();
});

function view(req, row) {
  const target = targetFor(req.telegramPartner, row);
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const logs = db.prepare('SELECT id,event_id AS eventId,event,click_id AS clickId,offer,amount,currency,delivery_status AS status,delivery_error AS error,attempts,created_at AS createdAt FROM conversion_events WHERE user_id=? ORDER BY id DESC LIMIT 50').all(row.user_id);
  return { enabled: !!row.enabled, chatId: row.chat_id, events: JSON.parse(row.events),
    hasCustomBot: !!row.bot_token, hasEffectiveBot: !!target.token, botSource: target.source,
    botTokenMasked: row.bot_token ? '••••' + row.bot_token.slice(-6) : '',
    endpoint: `${base}/api/postback/${row.user_id}`, secret: row.secret,
    templateUrl: `${base}/api/postback/${row.user_id}?key=${row.secret}&event=ftd&event_id={event_id}&click_id={click_id}&amount={payout}&currency={currency}&offer={offer_id}`,
    logs };
}

router.get('/partners/:id/telegram', (req, res) => res.json(view(req, settingsFor(req.telegramPartner.id))));
router.put('/partners/:id/telegram', (req, res) => {
  const partner = req.telegramPartner;
  const row = settingsFor(partner.id);
  const b = req.body || {};
  const token = b.clearBot ? '' : (typeof b.botToken === 'string' && b.botToken.trim() ? b.botToken.trim() : row.bot_token);
  const chat = typeof b.chatId === 'string' ? b.chatId.trim() : row.chat_id;
  const events = b.events === undefined ? JSON.parse(row.events) : b.events;
  if (token && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(400).json({ error: 'Некорректный токен BotFather.' });
  if (chat && !/^-?\d+$|^@[A-Za-z0-9_]{5,}$/.test(chat)) return res.status(400).json({ error: 'Укажите числовой Chat ID (у групп отрицательный) или @username канала.' });
  if (!Array.isArray(events) || events.some(e => !EVENTS.includes(e))) return res.status(400).json({ error: 'Недопустимые события.' });
  const enabled = b.enabled === undefined ? row.enabled : (b.enabled ? 1 : 0);
  if (enabled && (!chat || !events.length || !targetFor(partner, { bot_token: token, chat_id: chat }).token)) {
    return res.status(400).json({ error: 'Для включения выберите хотя бы одно событие, укажите бота и Chat ID.' });
  }
  db.prepare("UPDATE partner_telegram SET enabled=?,bot_token=?,chat_id=?,events=?,updated_by=?,updated_at=datetime('now') WHERE user_id=?")
    .run(enabled, token, chat, JSON.stringify([...new Set(events)]), req.userId, partner.id);
  res.json(view(req, settingsFor(partner.id)));
});
router.post('/partners/:id/telegram/rotate-key', (req, res) => {
  settingsFor(req.telegramPartner.id);
  db.prepare("UPDATE partner_telegram SET secret=?,updated_by=?,updated_at=datetime('now') WHERE user_id=?").run(crypto.randomBytes(32).toString('hex'), req.userId, req.telegramPartner.id);
  res.json(view(req, settingsFor(req.telegramPartner.id)));
});
router.post('/partners/:id/telegram/test', async (req, res) => {
  const p = req.telegramPartner;
  try {
    await sendTelegram(targetFor(p, settingsFor(p.id)), `✅ Тест Telegram-постбеков. Партнёр: ${p.first_name} (#${p.id}). Это тест, баланс и отчёты не меняются.`);
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
router.post('/partners/:id/telegram/retry/:eventId', async (req, res) => {
  const p = req.telegramPartner;
  const row = db.prepare('SELECT * FROM conversion_events WHERE id=? AND user_id=?').get(req.params.eventId,p.id);
  if (!row) return res.status(404).json({ error: 'Событие не найдено.' });
  if (row.delivery_status === 'sent' || row.delivery_status === 'skipped') return res.status(409).json({ error: 'Это событие уже доставлено или было отключено.' });
  const result = await deliver(p, settingsFor(p.id), row);
  res.status(result.status === 'failed' ? 502 : 200).json(result);
});
module.exports = router;

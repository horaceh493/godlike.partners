const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { EVENTS, deliver } = require('../utils/telegram-postbacks');
const router = express.Router();
router.use(rateLimit({ windowMs: 60000, limit: 600 }));
router.route('/:partnerId').get(receive).post(receive);

async function receive(req, res) {
  const b = req.method === 'GET' ? req.query : (req.body || {});
  const partner = db.prepare("SELECT * FROM users WHERE id=? AND role='partner' AND status='active'").get(req.params.partnerId);
  const config = partner && db.prepare('SELECT * FROM partner_telegram WHERE user_id=?').get(partner.id);
  const key = req.get('X-Postback-Key') || b.key;
  if (!config || typeof key !== 'string' || Buffer.byteLength(key) !== Buffer.byteLength(config.secret) ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.secret))) {
    return res.status(403).json({ error: 'Invalid postback key or partner.' });
  }
  const event = b.event;
  if (!EVENTS.includes(event)) return res.status(400).json({ error: 'event: registration, ftd, repeat or reject.' });
  if (typeof b.event_id !== 'string' || !b.event_id.trim() || b.event_id.length > 200 || /[{}]/.test(b.event_id)) {
    return res.status(400).json({ error: 'A stable unique event_id is required. Replace tracker macros.' });
  }
  const amount = b.amount == null || b.amount === '' ? 0 : Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) return res.status(400).json({ error: 'Invalid amount.' });
  const currency = b.currency || 'USD';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Use a 3-letter currency, e.g. USD.' });
  for (const field of ['click_id','offer']) if (b[field] != null && (typeof b[field] !== 'string' || b[field].length > 200)) return res.status(400).json({ error: 'Invalid ' + field });
  const eventId = b.event_id.trim(), clickId = b.click_id || '', offer = b.offer || '';
  const existing = db.prepare('SELECT * FROM conversion_events WHERE user_id=? AND event=? AND event_id=?').get(partner.id,event,eventId);
  if (existing && (existing.click_id !== clickId || existing.offer !== offer || existing.amount !== amount || existing.currency !== currency)) {
    return res.status(409).json({ error: 'This event_id already has different data.' });
  }
  if (existing && ['sent','skipped'].includes(existing.delivery_status)) return res.json({ ok:true, duplicate:true, status:existing.delivery_status });
  if (!existing) db.prepare('INSERT INTO conversion_events(user_id,event,event_id,click_id,offer,amount,currency) VALUES(?,?,?,?,?,?,?)')
    .run(partner.id,event,eventId,clickId,offer,amount,currency);
  const row = existing || db.prepare('SELECT * FROM conversion_events WHERE user_id=? AND event=? AND event_id=?').get(partner.id,event,eventId);
  const result = await deliver(partner, config, row);
  res.status(result.status === 'failed' ? 502 : (result.status === 'sending' ? 202 : 200)).json({ ok:result.status !== 'failed', ...result });
}
module.exports = router;

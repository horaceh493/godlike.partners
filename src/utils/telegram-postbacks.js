const crypto = require('crypto');
const db = require('../db');
const { adminById } = require('./team');

const EVENTS = ['registration', 'ftd', 'repeat', 'reject'];
const LABELS = { registration: 'Регистрация', ftd: 'Первый депозит', repeat: 'Повторный депозит', reject: 'Отклонение' };

function settingsFor(userId) {
  db.prepare('INSERT OR IGNORE INTO partner_telegram(user_id,secret) VALUES(?,?)').run(userId, crypto.randomBytes(32).toString('hex'));
  return db.prepare('SELECT * FROM partner_telegram WHERE user_id=?').get(userId);
}

function managerBot(ownerId) {
  let owner = adminById(ownerId || -1);
  const seen = new Set();
  while (owner && !seen.has(owner.id)) {
    seen.add(owner.id);
    if (owner.telegram_bot_token) return { token: owner.telegram_bot_token, source: owner.first_name };
    owner = owner.team_lead_id ? adminById(owner.team_lead_id) : null;
  }
  return { token: process.env.TELEGRAM_BOT_TOKEN || '', source: 'Общий бот сайта' };
}

function targetFor(partner, config) {
  const inherited = managerBot(partner.owner_admin_id);
  return { token: config.bot_token || inherited.token, chatId: config.chat_id,
    source: config.bot_token ? 'Индивидуальный бот партнёра' : inherited.source };
}

async function sendTelegram(target, text) {
  if (!target.token || !target.chatId) throw new Error('Укажите бота и Chat ID партнёра.');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(8000), body: JSON.stringify({ chat_id: target.chatId, text: text.slice(0,4000) })
    });
    const data = await response.json();
    if (response.ok && data.ok) return;
    const code = data.error_code || response.status;
    throw new Error(code === 401 ? 'Telegram: неверный токен бота.' : code === 403 ? 'Telegram: бот заблокирован или не имеет доступа к чату.' : code === 429 ? 'Telegram: лимит запросов. Повторите позже.' : 'Telegram: проверьте Chat ID, запуск бота и права на отправку (код ' + code + ').');
  } catch (error) {
    if (error.message.startsWith('Telegram:')) throw error;
    throw new Error('Telegram недоступен или не ответил за 8 секунд. Повторите отправку.');
  }
}

async function deliver(partner, config, eventRow) {
  if (!config.enabled || !JSON.parse(config.events).includes(eventRow.event)) {
    db.prepare("UPDATE conversion_events SET delivery_status='skipped',delivery_error='',updated_at=datetime('now') WHERE id=?").run(eventRow.id);
    return { status: 'skipped' };
  }
  const claimed = db.prepare(`UPDATE conversion_events SET delivery_status='sending',attempts=attempts+1,updated_at=datetime('now')
    WHERE id=? AND (delivery_status IN ('pending','failed') OR (delivery_status='sending' AND updated_at<datetime('now','-60 seconds')))`)
    .run(eventRow.id);
  if (!claimed.changes) return { status: eventRow.delivery_status, duplicate: true };
  try {
    // Do not include company profit, expenses, margins or personal bot tokens.
    await sendTelegram(targetFor(partner, config), `🔔 ${LABELS[eventRow.event]}\nПартнёр: ${partner.first_name} (#${partner.id})\nОффер: ${eventRow.offer || '—'}\nСобытие: ${eventRow.event_id}\nClick ID: ${eventRow.click_id || '—'}\nСумма события: ${eventRow.amount} ${eventRow.currency}`);
    db.prepare("UPDATE conversion_events SET delivery_status='sent',delivery_error='',updated_at=datetime('now') WHERE id=?").run(eventRow.id);
    return { status: 'sent' };
  } catch (error) {
    db.prepare("UPDATE conversion_events SET delivery_status='failed',delivery_error=?,updated_at=datetime('now') WHERE id=?").run(error.message, eventRow.id);
    return { status: 'failed', error: error.message };
  }
}

module.exports = { EVENTS, settingsFor, targetFor, sendTelegram, deliver };

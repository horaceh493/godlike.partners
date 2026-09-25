// Sends operational notifications (new registrations, logins, key actions) to
// Discord and/or Telegram, if configured via environment variables. Both are
// optional and independent -- set up either, both, or neither.
//
// Telegram can additionally be customized PER MANAGER: if a manager (admin)
// has their own bot token + chat id saved (src/routes/admin.js PUT
// /admins/:id/telegram), notifications about their own partners' actions go
// to that bot instead of the site-wide TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID.
// Discord stays site-wide only. Failures here are logged but never break the
// actual request.

const db = require('../db');

async function sendDiscord(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
    if (!res.ok) console.error('Discord notify failed:', res.status, await res.text());
  } catch (e) {
    console.error('Discord notify failed:', e.message);
  }
}

async function sendTelegram(message, target) {
  const token = target && target.token;
  const chatId = target && target.chatId;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    if (!res.ok) console.error('Telegram notify failed:', res.status, await res.text());
  } catch (e) {
    console.error('Telegram notify failed:', e.message);
  }
}

// Picks which Telegram bot should receive this notification: the owning
// manager's own bot if they've set one up, otherwise the site-wide default
// from environment variables (also used for admin-level events with no
// specific owner, e.g. an admin logging in).
function resolveTelegramTarget(ownerAdminId) {
  if (ownerAdminId) {
    try {
      const admin = db.prepare(`SELECT telegram_bot_token, telegram_chat_id FROM users WHERE id=? AND role='admin'`).get(ownerAdminId);
      if (admin && admin.telegram_bot_token && admin.telegram_chat_id) {
        return { token: admin.telegram_bot_token, chatId: admin.telegram_chat_id };
      }
    } catch (e) {
      // fall through to the site-wide default below
    }
  }
  return { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
}

// Turns a 2-letter country code (e.g. "US") into its flag emoji ("🇺🇸") by
// mapping each letter to its regional-indicator symbol.
function countryCodeToFlag(cc) {
  if (!cc || cc.length !== 2) return '';
  const code = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
}

// Lightweight user-agent sniffing -- good enough for "iPhone · Safari" style
// notification lines, no dependency needed.
function describeDevice(ua) {
  if (!ua) return 'Unknown device';
  let os = 'Unknown OS';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/ipad/i.test(ua)) os = 'iPad';
  else if (/iphone/i.test(ua)) os = 'iPhone';
  else if (/mac os/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown browser';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua) || /opera/i.test(ua)) browser = 'Opera';
  else if (/telegram/i.test(ua)) browser = 'Telegram in-app browser';
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) browser = 'Safari';

  return `${browser} · ${os}`;
}

function cleanIp(raw) {
  if (!raw) return '';
  // "x-forwarded-for" can carry a comma-separated chain; the first entry is the client.
  return String(raw).split(',')[0].trim().replace(/^::ffff:/, '');
}

function isPrivateIp(ip) {
  return !ip || ip === '127.0.0.1' || ip === '::1' ||
    ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

// Best-effort free geolocation lookup (no API key needed). Silently gives up
// on any error/timeout/private IP so a flaky network never delays a request.
async function geoLookup(ip) {
  if (!ip || isPrivateIp(ip)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,country,city`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (data.status !== 'success') return null;
    return data;
  } catch (e) {
    return null;
  }
}

// Builds the "🌐 IP: ... 🇺🇸 (City, Country)\n📱 Device: Chrome · Windows" block
// appended to a notification when a request object is supplied.
async function buildClientBlock(req) {
  if (!req) return '';
  const ip = cleanIp(req.ip || (req.headers && req.headers['x-forwarded-for']));
  const ua = (req.get && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || '';
  const geo = await geoLookup(ip);
  const flag = geo ? countryCodeToFlag(geo.countryCode) : '';
  const place = geo ? [geo.city, geo.country].filter(Boolean).join(', ') : '';
  const ipLine = `🌐 IP: ${ip || 'unknown'}${flag ? ' ' + flag : ''}${place ? ' (' + place + ')' : ''}`;
  const deviceLine = `📱 Device: ${describeDevice(ua)}`;
  return `\n${ipLine}\n${deviceLine}`;
}

// Fire-and-forget: doesn't block or throw into the caller's request.
// Pass the Express `req` as the second argument to auto-append IP (with a
// country flag when it can be resolved) and a friendly device/browser line.
// Pass { ownerAdminId } as the third argument when this notification is
// about a specific partner, so it can be routed to that partner's own
// manager's bot instead of the site-wide default.
function notifyOps(message, req, opts) {
  const ownerAdminId = opts && opts.ownerAdminId;
  const target = resolveTelegramTarget(ownerAdminId);
  const hasSink = !!(process.env.DISCORD_WEBHOOK_URL || (target.token && target.chatId));
  if (!hasSink) return; // nothing configured -- skip the geo lookup entirely
  if (req) {
    buildClientBlock(req)
      .then(extra => {
        const full = message + extra;
        sendDiscord(full);
        sendTelegram(full, target);
      })
      .catch(() => {
        sendDiscord(message);
        sendTelegram(message, target);
      });
  } else {
    sendDiscord(message);
    sendTelegram(message, target);
  }
}

module.exports = { notifyOps };

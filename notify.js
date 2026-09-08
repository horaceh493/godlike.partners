// Sends operational notifications (new registrations, logins) to Discord
// and/or Telegram, if configured via environment variables. Both are
// optional and independent -- set up either, both, or neither.
// Failures here are logged but never break the actual request.

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

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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

// Fire-and-forget: doesn't block or throw into the caller's request.
function notifyOps(message) {
  sendDiscord(message);
  sendTelegram(message);
}

module.exports = { notifyOps };

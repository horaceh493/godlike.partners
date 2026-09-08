const db = require('../db');

// Defaults for every setting the admin panel can edit. Keeping them here
// means a fresh database (or a key nobody has saved yet) always returns
// sensible values instead of undefined.
const DEFAULTS = {
  banner_enabled: '0',
  banner_image_url: '',
  banner_title: '',
  banner_subtitle: '',
  banner_link_url: '',
  banner_link_label: '',
  withdraw_notice_enabled: '0',
  withdraw_notice_title: 'Before you request a payout',
  withdraw_notice_body: 'Please double check your payout method details below. Payouts are reviewed by the team and can take up to 24 hours to process.'
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const map = Object.assign({}, DEFAULTS);
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function setSettings(patch) {
  const upsert = db.prepare(`
    INSERT INTO site_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const entries = Object.keys(DEFAULTS)
    .filter(k => Object.prototype.hasOwnProperty.call(patch, k))
    .map(k => [k, patch[k]]);
  for (const [k, v] of entries) upsert.run(k, String(v == null ? '' : v));
  return getSettings();
}

module.exports = { getSettings, setSettings, DEFAULTS };

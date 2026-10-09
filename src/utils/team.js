const db = require('../db');
const { getSettings } = require('./settings');

function adminById(id) {
  return db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(id);
}

function teamIds(admin) {
  if (admin.is_super_admin) return db.prepare("SELECT id FROM users WHERE role='admin'").all().map(r => r.id);
  return db.prepare(`WITH RECURSIVE team(id) AS (
    SELECT id FROM users WHERE id=? AND role='admin'
    UNION SELECT u.id FROM users u JOIN team t ON u.team_lead_id=t.id
    WHERE u.role='admin' AND u.is_super_admin=0
  ) SELECT id FROM team`).all(admin.id).map(r => r.id);
}

function canManageAdmin(actor, target) {
  return !!target && !target.is_super_admin && target.id !== actor.id &&
    (actor.is_super_admin || teamIds(actor).includes(target.id));
}

function canManagePartner(actor, partner) {
  return !!partner && partner.role === 'partner' &&
    (!!actor.is_super_admin || teamIds(actor).includes(partner.owner_admin_id));
}

function ownPayoutUrls(admin) {
  if (!admin) return [];
  let urls;
  try { urls = JSON.parse(admin.payout_urls || '[]'); } catch { urls = []; }
  if (!Array.isArray(urls)) urls = [];
  return [...new Set([admin.payout_method_url, ...urls].filter(u => typeof u === 'string' && u.trim()))];
}

// Resolve at read time, so changing the main/lead's links updates every
// inheriting manager without copying stale values into their accounts.
function payoutConfig(adminId) {
  let admin = adminById(adminId || -1);
  const seen = new Set();
  while (admin && !seen.has(admin.id)) {
    seen.add(admin.id);
    const urls = ownPayoutUrls(admin);
    if (urls.length) return { urls, sourceId: admin.id, sourceName: admin.first_name };
    admin = admin.team_lead_id ? adminById(admin.team_lead_id) : null;
  }
  const main = db.prepare("SELECT * FROM users WHERE role='admin' AND is_super_admin=1 ORDER BY id LIMIT 1").get();
  const mainUrls = ownPayoutUrls(main);
  if (mainUrls.length) return { urls: mainUrls, sourceId: main.id, sourceName: main.first_name };
  const url = getSettings().payout_method_url;
  return { urls: url ? [url] : [], sourceId: null, sourceName: 'Настройки сайта' };
}

const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Europe/Moscow';
// Validate on startup instead of failing silently when a report is opened.
new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE }).format();
function dateInZone(value = new Date()) {
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z'));
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
db.function('report_date', value => value ? dateInZone(value) : null);

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function audit(adminId, action, target = '') {
  db.prepare('INSERT INTO admin_audit_log(admin_id, action, target) VALUES(?,?,?)').run(adminId, action, String(target));
}

module.exports = { adminById, teamIds, canManageAdmin, canManagePartner, ownPayoutUrls, payoutConfig, REPORT_TIMEZONE, dateInZone, isValidDate, audit };

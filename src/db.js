const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically once a volume is
// attached -- no manual variable needed there. DATA_DIR is kept as a
// manual override for other hosts that don't set that automatically.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'godlike.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL DEFAULT 'partner',              -- 'partner' | 'admin'
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  telegram TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  country TEXT DEFAULT '',
  traffic_sources TEXT DEFAULT '[]',                 -- JSON array
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',              -- 'active' | 'blocked'
  tier_volume REAL NOT NULL DEFAULT 0,                -- lifetime earned $, drives NOVICE..GODLIKE tier
  balance REAL NOT NULL DEFAULT 0,                    -- withdrawable balance
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                                 -- 'payout' | 'credit'
  amount REAL NOT NULL,                               -- negative = payout, positive = credit
  method TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing',           -- 'processing' | 'paid' | 'credited' | 'rejected'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  sub1 TEXT DEFAULT '',
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postback_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  registration_enabled INTEGER DEFAULT 0,
  registration_url TEXT DEFAULT '',
  ftd_enabled INTEGER DEFAULT 0,
  ftd_url TEXT DEFAULT '',
  repeat_enabled INTEGER DEFAULT 0,
  repeat_url TEXT DEFAULT '',
  reject_enabled INTEGER DEFAULT 0,
  reject_url TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- raw click log for tracking links; not yet attributed to a partner or
-- reflected in stats -- see README "Next steps" for how to wire this up.
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  sub1 TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one thread per partner between them and support/admin
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,              -- 'admin' | 'partner'
  body TEXT NOT NULL,
  read_by_partner INTEGER DEFAULT 0,
  read_by_admin INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- offer catalog, managed from the admin panel
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  geo TEXT DEFAULT '',
  model TEXT DEFAULT '',
  conversion TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'paused'
  connected INTEGER NOT NULL DEFAULT 0,    -- has a real tracking destination
  download_url TEXT DEFAULT '',            -- external link (site or hosted apk)
  file_name TEXT DEFAULT '',               -- original uploaded filename, if any
  file_path TEXT DEFAULT '',               -- stored path under uploads/, if any
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// safe migration for databases created before the `conversion` column existed
try { db.exec('ALTER TABLE offers ADD COLUMN conversion TEXT DEFAULT \'\''); } catch (e) {}

// safe migrations for the admin hierarchy (super admin + per-admin partners)
try { db.exec('ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN owner_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch (e) {}
// per-admin referral alias, e.g. ref_slug='anna' -> yoursite.com/?ref=anna
try { db.exec('ALTER TABLE users ADD COLUMN ref_slug TEXT'); } catch (e) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_slug ON users(ref_slug) WHERE ref_slug IS NOT NULL'); } catch (e) {}
// per-admin override for the "set up payout method" button link -- if a manager
// has their own value here, their partners see it instead of the site-wide default
try { db.exec("ALTER TABLE users ADD COLUMN payout_method_url TEXT DEFAULT ''"); } catch (e) {}

// per-admin Telegram bot -- if a manager sets their own bot token + chat id,
// notifications about their own partners' actions go there instead of the
// site-wide TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID env vars.
try { db.exec("ALTER TABLE users ADD COLUMN telegram_bot_token TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT ''"); } catch (e) {}

// per-partner overrides: a partner's own manager can set custom withdrawal-notice
// and announcement-popup content just for that one partner, instead of the
// site-wide defaults in site_settings. The *_override flag says whether this
// partner has a custom value at all -- when it's 0, the partner falls back to
// the global site setting untouched.
try { db.exec('ALTER TABLE users ADD COLUMN notice_override INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN notice_enabled INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN notice_title TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN notice_body TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN notice_url TEXT DEFAULT ''"); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN announce_override INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN announce_enabled INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN announce_title TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN announce_body TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN announce_btn_label TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN announce_btn_url TEXT DEFAULT ''"); } catch (e) {}

// site-wide settings (partner dashboard banner, pre-withdrawal info modal, etc.)
// stored as simple key/value pairs so new settings can be added without more migrations
db.exec(`
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`);

const SEED_OFFERS = [
  { id: 'zeus', name: 'Zeus Casino', geo: 'DE, AT, CH', model: 'RevShare up to 45%', conversion: '28%', status: 'active' },
  { id: 'goldenreel', name: 'Golden Reel', geo: 'BR, PT', model: 'CPA $40', conversion: '24%', status: 'active' },
  { id: 'royalslots', name: 'Royal Slots', geo: 'IN, BD', model: 'Hybrid', conversion: '31%', status: 'active' },
  { id: 'luckyempire', name: 'Lucky Empire', geo: 'CIS', model: 'RevShare up to 40%', conversion: '26%', status: 'active' },
  { id: 'spinlegends', name: 'Spin Legends', geo: 'TR, AZ', model: 'CPA $35', conversion: '19%', status: 'paused' },
  { id: 'olimp', name: 'Olimp Casino', geo: 'Worldwide', model: 'RevShare up to 40%', conversion: '30%', status: 'active' },
  { id: 'mostbet', name: 'Mostbet', geo: 'Worldwide', model: 'RevShare up to 40%', conversion: '33%', status: 'active' }
];
const offerCount = db.prepare('SELECT COUNT(*) AS c FROM offers').get().c;
if (offerCount === 0) {
  const insertOffer = db.prepare('INSERT INTO offers (id, name, geo, model, conversion, status) VALUES (?,?,?,?,?,?)');
  for (const o of SEED_OFFERS) insertOffer.run(o.id, o.name, o.geo, o.model, o.conversion, o.status);
}

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;

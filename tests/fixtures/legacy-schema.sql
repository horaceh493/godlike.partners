BEGIN TRANSACTION;
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE admin_daily_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date TEXT NOT NULL,             -- 'YYYY-MM-DD'
  tg_posts INTEGER NOT NULL DEFAULT 0,
  groups_created INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(admin_id, activity_date)
);
INSERT INTO "admin_daily_activity" VALUES(1,1,'2026-10-01',25,2,'2026-10-07 12:03:10');
CREATE TABLE admin_profit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,                -- 'YYYY-MM-DD', when it was logged
  partner_tg TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, expense_amount REAL NOT NULL DEFAULT 0);
INSERT INTO "admin_profit_entries" VALUES(1,1,'2026-10-01','@legacy',90.0,'2026-10-07 12:03:10',4.0);
CREATE TABLE clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  sub1 TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE company_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT NOT NULL,              -- 'YYYY-MM-DD'
  label TEXT NOT NULL DEFAULT '',          -- e.g. 'Электричество', 'Хостинг', 'Прокси'
  amount REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "company_expenses" VALUES(1,'2026-10-01','Legacy expense',10.0,'',1,'2026-10-07 12:03:10');
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  sub1 TEXT DEFAULT '',
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,              -- 'admin' | 'partner'
  body TEXT NOT NULL,
  read_by_partner INTEGER DEFAULT 0,
  read_by_admin INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE offers (
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
INSERT INTO "offers" VALUES('zeus','Zeus Casino','DE, AT, CH','RevShare up to 45%','28%','active',0,'','','','2026-10-07 12:03:10');
INSERT INTO "offers" VALUES('goldenreel','Golden Reel','BR, PT','CPA $40','24%','active',0,'','','','2026-10-07 12:03:10');
INSERT INTO "offers" VALUES('royalslots','Royal Slots','IN, BD','Hybrid','31%','active',0,'','','','2026-10-07 12:03:10');
INSERT INTO "offers" VALUES('luckyempire','Lucky Empire','CIS','RevShare up to 40%','26%','active',0,'','','','2026-10-07 12:03:10');
INSERT INTO "offers" VALUES('spinlegends','Spin Legends','TR, AZ','CPA $35','19%','paused',0,'','','','2026-10-07 12:03:10');
INSERT INTO "offers" VALUES('olimp','Olimp Casino','Worldwide','RevShare up to 40%','30%','active',0,'','','','2026-10-07 12:03:10');
INSERT INTO "offers" VALUES('mostbet','Mostbet','Worldwide','RevShare up to 40%','33%','active',0,'','','','2026-10-07 12:03:10');
CREATE TABLE payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE postback_settings (
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
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                                 -- 'payout' | 'credit'
  amount REAL NOT NULL,                               -- negative = payout, positive = credit
  method TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing',           -- 'processing' | 'paid' | 'credited' | 'rejected'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users (
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
, is_super_admin INTEGER NOT NULL DEFAULT 0, owner_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL, ref_slug TEXT, payout_method_url TEXT DEFAULT '', telegram_bot_token TEXT DEFAULT '', telegram_chat_id TEXT DEFAULT '', notice_override INTEGER NOT NULL DEFAULT 0, notice_enabled INTEGER NOT NULL DEFAULT 0, notice_title TEXT DEFAULT '', notice_body TEXT DEFAULT '', notice_url TEXT DEFAULT '', announce_override INTEGER NOT NULL DEFAULT 0, announce_enabled INTEGER NOT NULL DEFAULT 0, announce_title TEXT DEFAULT '', announce_body TEXT DEFAULT '', announce_btn_label TEXT DEFAULT '', announce_btn_url TEXT DEFAULT '', payout_urls TEXT DEFAULT '[]');
INSERT INTO "users" VALUES(1,'admin','Legacy Manager','','legacy@example.test','','','','[]','test-only-hash','active',0.0,0.0,'2026-10-07 12:03:10',1,NULL,NULL,'https://old.example.test/pay','','',0,0,'','','',0,0,'','','','','["https://old.example.test/pay","https://old.example.test/second"]');
INSERT INTO "users" VALUES(2,'partner','Legacy Partner','','legacy-partner@example.test','','','','[]','test-only-hash','active',0.0,123.45,'2026-10-07 12:03:10',0,1,NULL,'','','',0,0,'','','',0,0,'','','','','[]');
CREATE UNIQUE INDEX idx_users_ref_slug ON users(ref_slug) WHERE ref_slug IS NOT NULL;
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('users',2);
INSERT INTO "sqlite_sequence" VALUES('admin_profit_entries',1);
INSERT INTO "sqlite_sequence" VALUES('company_expenses',1);
INSERT INTO "sqlite_sequence" VALUES('admin_daily_activity',1);
COMMIT;

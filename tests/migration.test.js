const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('original database upgrades twice without losing users, settings, money or reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'godlike-migration-'));
  try {
    const old = new DatabaseSync(path.join(dir,'godlike.db'));
    old.exec('PRAGMA foreign_keys=OFF'); // sqlite dump inserts tables alphabetically
    old.exec(fs.readFileSync(path.join(__dirname,'fixtures/legacy-schema.sql'),'utf8'));
    old.close();
    const env = {...process.env, DATA_DIR:dir};delete env.RAILWAY_VOLUME_MOUNT_PATH;
    for (let i=0;i<2;i++) {
      const r=spawnSync(process.execPath,['-e',"const db=require('./src/db'); db.close();"],{cwd:path.join(__dirname,'..'),env,encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);
    }
    const db = new DatabaseSync(path.join(dir,'godlike.db'));
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c,2);
    const main = db.prepare('SELECT * FROM users WHERE id=1').get();
    assert.equal(main.email,'legacy@example.test');assert.equal(main.team_lead_id,null);assert.equal(main.session_version,0);
    assert.deepEqual(JSON.parse(main.payout_urls),['https://old.example.test/pay','https://old.example.test/second']);
    assert.equal(db.prepare('SELECT balance FROM users WHERE id=2').get().balance,123.45);
    assert.equal(db.prepare('SELECT amount FROM admin_profit_entries').get().amount,90);
    assert.equal(db.prepare('SELECT expense_amount FROM admin_profit_entries').get().expense_amount,4);
    assert.equal(db.prepare('SELECT amount FROM company_expenses').get().amount,10);
    assert.equal(db.prepare('SELECT admin_id FROM company_expenses').get().admin_id,null);
    assert.equal(db.prepare('SELECT tg_posts FROM admin_daily_activity').get().tg_posts,25);
    for(const table of ['partner_telegram','conversion_events','admin_audit_log','partner_owner_history']) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c,0);
    db.close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

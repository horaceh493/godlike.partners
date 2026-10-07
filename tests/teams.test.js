const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(),'godlike-team-test-'));
process.env.DATA_DIR = dir;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
process.env.JWT_SECRET = 'integration-test-secret-not-for-production';
process.env.ADMIN_EMAIL = 'root@example.test';
process.env.ADMIN_PASSWORD = 'Root-test-123';
process.env.REPORT_TIMEZONE = 'Europe/Moscow';
process.env.PUBLIC_URL = 'https://partners.example.test';
process.env.NODE_ENV = 'test';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.DISCORD_WEBHOOK_URL;
const httpFetch = global.fetch;
let telegramFailure = false;
let telegramCalls = [];
// No external notifications are sent by the test suite.
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    telegramCalls.push({url:String(url),body:JSON.parse(options.body)});
    return new Response(JSON.stringify(telegramFailure ? {ok:false,error_code:403} : {ok:true,result:{message_id:1}}), {status:telegramFailure?403:200});
  }
  throw new Error('Unexpected external request in test');
};
const app = require('../server');
const db = require('../src/db');
const { dateInZone } = require('../src/utils/team');
let server, base, root, lead, other, child, grandchild, p1, p2, rootId, profitId;
const day = dateInZone();
async function request(cookie, url, method='GET', body, expected=200) {
  const r = await httpFetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data = await r.json();
  assert.equal(r.status,expected,`${method} ${url}: ${JSON.stringify(data)}`);
  return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function login(email, password='Manager-test-123') {
  return (await request(null,'/api/auth/login','POST',{email,password})).cookie;
}
async function add(cookie,name,parent) {
  const email=name.toLowerCase()+'@example.test';
  const data=(await request(cookie,'/api/admin/admins','POST',{firstName:name,email,password:'Manager-test-123',...(parent===undefined?{}:{teamLeadId:parent})},201)).data;
  return {...data,cookie:await login(email)};
}
async function partner(name,owner) {
  const r=await request(null,'/api/auth/register','POST',{firstName:name,email:name+'@example.test',password:'Partner-test-123',ref:owner.refSlug});
  return {...(await request(r.cookie,'/api/me')).data,cookie:r.cookie};
}
function noPrivateFields(data) {
  const s=JSON.stringify(data);
  for(const field of ['expenseAmount','expense_amount','ownerGross','ownerNet','gatewayCost','managerShare','netProfit','password_hash','telegram_bot_token','session_version']) assert(!s.includes('"'+field+'"'),`Leaked ${field}`);
}
before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  root=await login(process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD);
  rootId=(await request(root,'/api/me')).data.id;
  lead=await add(root,'Lead'); other=await add(root,'Other'); child=await add(lead.cookie,'Child'); grandchild=await add(child.cookie,'Grandchild');
  p1=await partner('partner1',child);p2=await partner('partner2',other);
});
after(async()=>{ await new Promise(r=>server.close(r));db.close();global.fetch=httpFetch;fs.rmSync(dir,{recursive:true,force:true}); });

test('every manager can create a team; main admin sees the full tree',async()=>{
  assert.equal(child.teamLeadId,lead.id);assert.equal(grandchild.teamLeadId,child.id);
  const all=(await request(root,'/api/admin/admins')).data;
  assert.equal(all.length,5);
  const team=(await request(lead.cookie,'/api/admin/admins')).data;
  assert.deepEqual(team.map(x=>x.id),[lead.id,child.id,grandchild.id]);
  noPrivateFields(team);
  await request(lead.cookie,'/api/admin/admins','POST',{firstName:'Bad',email:'bad@example.test',password:'Manager-test-123',teamLeadId:other.id},403);
  await request(lead.cookie,`/api/admin/admins/${other.id}/status`,'PUT',{status:'blocked'},403);
  await request(child.cookie,`/api/admin/admins/${lead.id}/reset-password`,'POST',{password:'new-password-123'},403);
  await request(lead.cookie,`/api/admin/admins/${rootId}/status`,'PUT',{status:'blocked'},403);
  await request(lead.cookie,`/api/admin/admins/${lead.id}/status`,'PUT',{status:'blocked'},403);
  await request(lead.cookie,`/api/admin/admins/${child.id}/team-lead`,'PUT',{teamLeadId:other.id},403);
});

test('hierarchy rejects cycles; reassignment changes scope immediately',async()=>{
  await request(root,`/api/admin/admins/${lead.id}/team-lead`,'PUT',{teamLeadId:grandchild.id},400);
  await request(root,`/api/admin/admins/${child.id}/team-lead`,'PUT',{teamLeadId:child.id},400);
  await request(root,`/api/admin/admins/${child.id}/team-lead`,'PUT',{teamLeadId:other.id});
  await request(lead.cookie,`/api/admin/partners/${p1.id}`,'GET',undefined,403);
  await request(root,`/api/admin/admins/${child.id}/team-lead`,'PUT',{teamLeadId:lead.id});
});

test('partners and payouts are isolated by the full team scope',async()=>{
  assert.deepEqual((await request(lead.cookie,'/api/admin/partners')).data.map(x=>x.id),[p1.id]);
  await request(lead.cookie,`/api/admin/partners/${p1.id}`);
  for(const suffix of ['', '/messages','/telegram']) await request(lead.cookie,`/api/admin/partners/${p2.id}${suffix}`,'GET',undefined,403);
  await request(lead.cookie,`/api/admin/partners/${p2.id}/credit`,'POST',{amount:10},403);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/credit`,'POST',{amount:10});
  const t=db.prepare("INSERT INTO transactions(user_id,type,amount,status) VALUES(?,'payout',-2,'processing')").run(p2.id);
  assert.equal((await request(lead.cookie,'/api/admin/payouts')).data.length,0);
  await request(lead.cookie,`/api/admin/transactions/${t.lastInsertRowid}/settle`,'POST',{action:'paid'},403);
});

test('payout URLs inherit live from main admin/lead and only main admin can edit',async()=>{
  const urls=['https://payments.example.test/main','https://payments.example.test/second'];
  await request(root,`/api/admin/admins/${rootId}/payout-url`,'PUT',{urls});
  assert.deepEqual((await request(lead.cookie,`/api/admin/partners/${p1.id}`)).data.payoutUrls,urls);
  assert.equal((await request(p1.cookie,'/api/settings')).data.payout_method_url,urls[0]);
  for(const id of [rootId,lead.id,child.id]) await request(lead.cookie,`/api/admin/admins/${id}/payout-url`,'PUT',{urls:['https://bad.example.test']},403);
  await request(lead.cookie,'/api/admin/settings','PUT',{payout_method_url:'https://bad.example.test'},403);
  await request(root,`/api/admin/admins/${lead.id}/payout-url`,'PUT',{urls:['javascript:alert(1)']},400);
  await request(root,`/api/admin/admins/${lead.id}/payout-url`,'PUT',{urls:['https://payments.example.test/team','https://payments.example.test/extra']});
  await request(lead.cookie,`/api/admin/partners/${p1.id}/payout-url`,'PUT',{url:'https://payments.example.test/extra'});
  assert.equal((await request(p1.cookie,'/api/settings')).data.payout_method_url,'https://payments.example.test/extra');
  await request(lead.cookie,`/api/admin/partners/${p1.id}/payout-url`,'PUT',{url:urls[0]},400);
  await request(root,`/api/admin/admins/${lead.id}/payout-url`,'PUT',{urls:[]});
  assert.equal((await request(p1.cookie,'/api/settings')).data.payout_method_url,urls[0]);
});

test('private finance fields cannot be read or written by managers or team leads',async()=>{
  const e=(await request(child.cookie,'/api/admin/report/profit','POST',{partnerTg:'@partner',amount:100,date:day})).data;profitId=e.id;
  noPrivateFields(e);
  await request(root,`/api/admin/report/profit/${profitId}`,'PUT',{expenseAmount:5});
  noPrivateFields((await request(child.cookie,'/api/admin/report/profit')).data);
  noPrivateFields((await request(child.cookie,`/api/admin/report/profit/${profitId}`,'PUT',{amount:100})).data);
  await request(child.cookie,`/api/admin/report/profit/${profitId}`,'PUT',{expenseAmount:0},403);
  await request(child.cookie,'/api/admin/report/profit','POST',{partnerTg:'@p',amount:10,expenseAmount:0},403);
  for(const route of ['/finance/entries','/finance/expenses','/finance/managers','/finance/overview']) await request(lead.cookie,'/api/admin'+route,'GET',undefined,403);
  noPrivateFields((await request(lead.cookie,'/api/admin/stats/daily?date='+day)).data);
  await request(lead.cookie,`/api/admin/report/profit/${profitId}`,'DELETE',undefined,403);
  await request(p1.cookie,'/api/admin/stats/daily','GET',undefined,403);
});

test('per-manager P&L reconciles to company total without double counting expenses',async()=>{
  await request(root,'/api/admin/finance/expenses','POST',{adminId:child.id,date:day,label:'Tools',amount:7});
  await request(root,'/api/admin/finance/expenses','POST',{date:day,label:'Hosting',amount:3});
  const data=(await request(root,'/api/admin/finance/managers?date='+day)).data;
  const r=data.managers.find(x=>x.adminId===child.id);
  assert.deepEqual([r.income,r.managerShare,r.gatewayCost,r.entryExpenses,r.managerExpenses,r.expenses,r.netProfit],[100,50,20,5,7,82,18]);
  assert.equal(data.companyNetProfit,15);assert.equal(data.unallocatedExpenses,3);
  assert.equal((await request(root,'/api/admin/finance/overview?date='+day)).data.day.ownerNet,15);
  // The threshold is strictly greater than $50, as in the original project.
  await request(child.cookie,`/api/admin/report/profit/${profitId}`,'PUT',{amount:50});
  const lower=(await request(root,'/api/admin/finance/managers?date='+day)).data.managers.find(x=>x.adminId===child.id);
  assert.equal(lower.gatewayCost,0);assert.equal(lower.netProfit,13);
  await request(child.cookie,`/api/admin/report/profit/${profitId}`,'PUT',{amount:100});
});

test('daily report distinguishes submitted reports and automatic actions in Moscow time',async()=>{
  await request(child.cookie,'/api/admin/report/activity','PUT',{date:day,tgPosts:42,groupsCreated:3});
  await request(child.cookie,'/api/admin/report/activity','PUT',{date:'2026-02-30',tgPosts:1,groupsCreated:1},400);
  await request(child.cookie,'/api/admin/report/activity','PUT',{date:day,tgPosts:-1,groupsCreated:1},400);
  const data=(await request(lead.cookie,'/api/admin/stats/daily?date='+day)).data;
  assert.equal(data.timezone,'Europe/Moscow');assert(!data.admins.some(x=>x.adminId===other.id));
  const c=data.admins.find(x=>x.adminId===child.id),g=data.admins.find(x=>x.adminId===grandchild.id);
  assert.equal(c.tgPosts,42);assert.equal(c.groupsCreated,3);assert(c.reportSubmitted);assert(c.actionsToday>=3);assert.equal(g.reportSubmitted,false);
  db.prepare("INSERT INTO admin_audit_log(admin_id,action,created_at) VALUES(?,'TEST','2026-10-06 21:30:00')").run(child.id);
  const historical=(await request(lead.cookie,'/api/admin/stats/daily?date=2026-10-07')).data;
  assert(historical.admins.find(x=>x.adminId===child.id).recentActions.some(x=>x.action==='TEST'));
});

test('Telegram partner settings, actual delivery, deduplication, retry, and key rotation',async()=>{
  const cfg=(await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram`)).data;
  assert(cfg.templateUrl.startsWith('https://partners.example.test/api/postback/'));
  assert.equal(cfg.secret.length,64);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram`,'PUT',{enabled:true,chatId:'123456'},400);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram`,'PUT',{enabled:true,botToken:'123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi',chatId:'-100123456789',events:['ftd']});
  const safe=(await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram`)).data;
  assert(!JSON.stringify(safe).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi'));
  await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram/test`,'POST');
  const route='/api/postback/'+p1.id;
  const payload={key:cfg.secret,event:'ftd',event_id:'conversion-1',click_id:'click-1',amount:'20',currency:'USD',offer:'Offer A'};
  await request(null,route,'POST',{...payload,key:'wrong'},403);
  await request(null,route,'POST',{...payload,key:'я'.repeat(64)},403);
  await request(null,route,'POST',{...payload,event_id:'{event_id}'},400);
  const balance=db.prepare('SELECT balance FROM users WHERE id=?').get(p1.id).balance;
  const calls=telegramCalls.length;
  assert.equal((await request(null,route,'POST',payload)).data.status,'sent');
  assert.equal((await request(null,route+'?'+new URLSearchParams(payload))).data.duplicate,true);
  assert.equal(telegramCalls.length,calls+1);
  assert.equal(telegramCalls.at(-1).body.chat_id,'-100123456789');
  assert.equal(db.prepare('SELECT balance FROM users WHERE id=?').get(p1.id).balance,balance);
  await request(null,route,'POST',{...payload,amount:'21'},409);
  assert.equal((await request(null,route,'POST',{...payload,event_id:'reg-1',event:'registration'})).data.status,'skipped');
  telegramFailure=true;
  await request(null,route,'POST',{...payload,event_id:'failed-1'},502);
  telegramFailure=false;
  const logs=(await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram`)).data.logs;
  const failed=logs.find(x=>x.eventId==='failed-1');assert.equal(failed.status,'failed');
  await request(other.cookie,`/api/admin/partners/${p1.id}/telegram/retry/${failed.id}`,'POST',undefined,403);
  assert.equal((await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram/retry/${failed.id}`,'POST')).data.status,'sent');
  await request(lead.cookie,`/api/admin/partners/${p1.id}/telegram/rotate-key`,'POST');
  await request(null,route,'POST',{...payload,event_id:'old-key'},403);
});

test('unassigned partners can be found by exact email and claimed by a lead',async()=>{
  const r=await request(null,'/api/auth/register','POST',{firstName:'Unassigned',email:'unassigned@example.test',password:'Partner-test-123'});
  const p=(await request(r.cookie,'/api/me')).data;
  assert(!(await request(lead.cookie,'/api/admin/partners')).data.some(x=>x.id===p.id));
  const preview=(await request(lead.cookie,'/api/admin/partners/unassigned?email=UNASSIGNED%40example.test')).data;
  assert.deepEqual(Object.keys(preview).sort(),['email','firstName','id','lastName']);
  assert.equal(preview.id,p.id);
  await request(lead.cookie,'/api/admin/partners/claim','POST',{email:p.email,adminId:other.id},403);
  await request(lead.cookie,'/api/admin/partners/claim','POST',{email:p.email,adminId:rootId},403);
  await request(lead.cookie,'/api/admin/partners/claim','POST',{email:p.email,adminId:null},400);
  const claimed=(await request(lead.cookie,'/api/admin/partners/claim','POST',{email:p.email,adminId:child.id})).data;
  assert.equal(claimed.ownerAdminId,child.id);
  assert((await request(child.cookie,'/api/admin/partners')).data.some(x=>x.id===p.id));
  await request(other.cookie,'/api/admin/partners/claim','POST',{email:p.email,adminId:other.id},409);
  await request(other.cookie,'/api/admin/partners/unassigned?email='+encodeURIComponent(p.email),'GET',undefined,404);
  await request(p1.cookie,'/api/admin/partners/claim','POST',{email:p.email,adminId:other.id},403);
  const main=(await request(root,'/api/admin/partners/'+p.id)).data;
  assert.equal(main.ownerHistory.length,1);assert.equal(main.ownerHistory[0].actorName,'Lead');
  assert.equal(main.ownerHistory[0].toName,'Child');
  assert(!('ownerHistory' in (await request(lead.cookie,'/api/admin/partners/'+p.id)).data));
});

test('partner transfers stay within the lead scope and preserve account data',async()=>{
  await request(child.cookie,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:lead.id},403);
  await request(lead.cookie,`/api/admin/partners/${p2.id}/owner`,'PUT',{adminId:child.id},403);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:other.id},403);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:null},400);
  const before=db.prepare('SELECT * FROM users WHERE id=?').get(p1.id);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:lead.id});
  await request(child.cookie,`/api/admin/partners/${p1.id}`,'GET',undefined,403);
  await request(lead.cookie,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:grandchild.id});
  const after=db.prepare('SELECT * FROM users WHERE id=?').get(p1.id);
  assert.equal(after.balance,before.balance);assert.equal(after.email,before.email);assert.equal(after.password_hash,before.password_hash);
  await request(root,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:other.id});
  await request(lead.cookie,`/api/admin/partners/${p1.id}`,'GET',undefined,403);
  await request(root,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:child.id});
  const history=(await request(root,`/api/admin/partners/${p1.id}`)).data.ownerHistory;
  assert.equal(history.length,4);
  assert.equal(history[0].toName,'Child');
  // Repeated no-op assignment does not manufacture an extra history entry.
  await request(lead.cookie,`/api/admin/partners/${p1.id}/owner`,'PUT',{adminId:child.id});
  assert.equal((await request(root,`/api/admin/partners/${p1.id}`)).data.ownerHistory.length,4);
});

test('a signed referral cookie restores registration ownership without localStorage',async()=>{
  const landing=await httpFetch(base+'/?ref='+lead.refSlug);
  assert.equal(landing.status,200);
  const cookie=landing.headers.getSetCookie().find(x=>x.startsWith('godlike_ref=')).split(';')[0];
  const r=await request(cookie,'/api/auth/register','POST',{firstName:'Cookie partner',email:'cookie-partner@example.test',password:'Partner-test-123'});
  const u=(await request(r.cookie,'/api/me')).data;
  assert.equal(db.prepare('SELECT owner_admin_id FROM users WHERE id=?').get(u.id).owner_admin_id,lead.id);
  // An existing account is never reassigned merely by following another link.
  await httpFetch(base+'/?ref='+other.refSlug,{headers:{cookie:p1.cookie}});
  assert.equal(db.prepare('SELECT owner_admin_id FROM users WHERE id=?').get(p1.id).owner_admin_id,child.id);
  const forged=await request('godlike_ref=invalid-token','/api/auth/register','POST',{firstName:'No referral',email:'bad-cookie@example.test',password:'Partner-test-123'});
  const otherUser=(await request(forged.cookie,'/api/me')).data;
  assert.equal(db.prepare('SELECT owner_admin_id FROM users WHERE id=?').get(otherUser.id).owner_admin_id,null);
});

test('blocking and password reset revoke existing manager sessions',async()=>{
  const old=child.cookie;
  await request(lead.cookie,`/api/admin/admins/${child.id}/status`,'PUT',{status:'blocked'});
  await request(old,'/api/me','GET',undefined,401);
  await request(null,'/api/auth/login','POST',{email:child.email,password:'Manager-test-123'},403);
  await request(lead.cookie,`/api/admin/admins/${child.id}/status`,'PUT',{status:'active'});
  await request(old,'/api/me','GET',undefined,401);
  child.cookie=await login(child.email);
  await request(lead.cookie,`/api/admin/admins/${child.id}/reset-password`,'POST',{password:'New-manager-456'});
  await request(child.cookie,'/api/me','GET',undefined,401);
  await request(null,'/api/auth/login','POST',{email:child.email,password:'Manager-test-123'},401);
  child.cookie=await login(child.email,'New-manager-456');
  await request(child.cookie,'/api/me');
  const own=await request(child.cookie,'/api/me/password','PUT',{newPassword:'New-manager-789'});
  await request(child.cookie,'/api/me','GET',undefined,401);
  await request(own.cookie,'/api/me');
});

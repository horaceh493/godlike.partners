const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

const REF_COOKIE = 'godlike_ref';
const REF_COOKIE_OPTIONS = { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', path:'/', maxAge:30*24*60*60*1000 };

// A signed cookie keeps the last valid landing link if localStorage is blocked
// or the user returns without the URL parameter. It never reassigns an account.
function captureReferral(req,res,next) {
  const slug = typeof req.query.ref==='string' ? req.query.ref.trim().toLowerCase() : '';
  if (slug) {
    const manager=db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' AND ref_slug=?").get(slug);
    if (manager) res.cookie(REF_COOKIE,jwt.sign({purpose:'partner-referral',adminId:manager.id},JWT_SECRET,{expiresIn:'30d'}),REF_COOKIE_OPTIONS);
  }
  next();
}

function referralOwner(req,ref) {
  const slug = typeof ref==='string' ? ref.trim().toLowerCase() : '';
  if (slug) return db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' AND ref_slug=?").get(slug)?.id || null;
  try {
    const data=jwt.verify(req.cookies?.[REF_COOKIE] || '',JWT_SECRET);
    if (data.purpose!=='partner-referral') return null;
    return db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' AND id=?").get(data.adminId)?.id || null;
  } catch { return null; }
}

function clearReferral(res) {
  const {maxAge,...options}=REF_COOKIE_OPTIONS;
  res.clearCookie(REF_COOKIE,options);
}

module.exports = {captureReferral,referralOwner,clearReferral};

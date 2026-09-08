const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-secret-change-me') {
  console.warn('WARNING: using the default JWT_SECRET in production. Set JWT_SECRET in your .env file.');
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
};

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Super admins can create/manage other admins and reassign which admin a
// partner belongs to. Regular admins only see and manage their own partners.
function requireSuperAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  const row = db.prepare('SELECT is_super_admin FROM users WHERE id=?').get(req.userId);
  if (!row || !row.is_super_admin) return res.status(403).json({ error: 'Only the main admin can do this.' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, requireSuperAdmin, COOKIE_OPTS, JWT_SECRET };

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, COOKIE_OPTS } = require('../middleware/auth');
const { notifyOps } = require('../utils/notify');

const router = express.Router();

router.post('/register', (req, res) => {
  const { firstName, lastName, email, password, telegram, trafficSources } = req.body || {};
  if (!firstName || !email || !password) {
    return res.status(400).json({ error: 'First name, email and password are required.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (role, first_name, last_name, email, telegram, traffic_sources, password_hash)
    VALUES ('partner', ?, ?, ?, ?, ?, ?)
  `).run(firstName, lastName || '', String(email).toLowerCase(), telegram || '', JSON.stringify(trafficSources || []), hash);

  db.prepare('INSERT INTO postback_settings (user_id) VALUES (?)').run(info.lastInsertRowid);
  db.prepare('INSERT INTO activity_log (user_id, message) VALUES (?, ?)').run(info.lastInsertRowid, 'Account created');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ ok: true });

  notifyOps(
    `🆕 New partner registered\n` +
    `Name: ${firstName} ${lastName || ''}\n` +
    `Email: ${email}\n` +
    `IP: ${req.ip}\n` +
    `Device: ${req.get('user-agent') || 'unknown'}`
  );
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (user.status === 'blocked') {
    return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
  }
  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ ok: true, role: user.role });

  notifyOps(
    `🔓 Login: ${user.email} (${user.role})\n` +
    `IP: ${req.ip}\n` +
    `Device: ${req.get('user-agent') || 'unknown'}`
  );
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});

module.exports = router;

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = require('./src/db');
const authRoutes = require('./src/routes/auth');
const partnerRoutes = require('./src/routes/partner');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.set('trust proxy', 1);

// CSP is disabled because the bundled frontend uses inline <style> and
// inline event handlers to stay dependency-free. Tighten this once you
// move styles/scripts into external files.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api', partnerRoutes);
app.use('/api/admin', adminRoutes);

// Foundation for real click tracking: logs the click, then should redirect
// to the real casino product URL for that offer. See README "Next steps".
app.get('/go/:offerId', (req, res) => {
  db.prepare('INSERT INTO clicks (offer_id, sub1, ip) VALUES (?, ?, ?)')
    .run(req.params.offerId, req.query.sub1 || '', req.ip);
  res.send(
    'Click logged for offer "' + req.params.offerId + '". ' +
    'Replace this response in server.js with a redirect to the real offer URL, e.g. res.redirect(realOfferUrl).'
  );
});

app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/uploads', express.static(path.join(db.DATA_DIR, 'uploads'), {
  setHeaders: (res, filePath) => {
    if (filePath.toLowerCase().endsWith('.apk')) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));
app.use('/', express.static(path.join(__dirname, 'public/partner')));

function ensureAdmin() {
  const existing = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get();
  if (existing) return;
  const email = process.env.ADMIN_EMAIL || 'admin@godlikepartners.com';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (role, first_name, email, password_hash, is_super_admin) VALUES ('admin','Admin',?,?,1)`)
    .run(email.toLowerCase(), hash);
  console.log(`Created default admin account: ${email} / ${password}  -- change this password after first login`);
}
ensureAdmin();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Godlike Partners running on http://localhost:${PORT}`);
  console.log(`Admin panel:   http://localhost:${PORT}/admin`);
});

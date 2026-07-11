require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new Database('./data.db');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    referral_code TEXT UNIQUE NOT NULL,
    premium_expires INTEGER DEFAULT 0,
    referred_by INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    referrer_id INTEGER NOT NULL,
    redeemed_by INTEGER NOT NULL,
    redeemed_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (referrer_id) REFERENCES users(id),
    FOREIGN KEY (redeemed_by) REFERENCES users(id)
  );
`);

// Auth middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const generateCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, referralCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const hash = await bcrypt.hash(password, 10);
  const code = generateCode();

  try {
    const insert = db.prepare('INSERT INTO users (email, password, referral_code) VALUES (?, ?, ?)');
    const result = insert.run(email, hash, code);
    const userId = result.lastInsertRowid;

    let premiumExpires = 0;

    if (referralCode) {
      const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(referralCode);
      if (referrer && referrer.id !== userId) {
        const now = Math.floor(Date.now() / 1000);
        const eightDays = 8 * 24 * 60 * 60;
        premiumExpires = now + eightDays;

        db.prepare('UPDATE users SET premium_expires = ?, referred_by = ? WHERE id = ?')
          .run(premiumExpires, referrer.id, userId);

        db.prepare('INSERT INTO redemptions (code, referrer_id, redeemed_by) VALUES (?, ?, ?)')
          .run(referralCode, referrer.id, userId);
      }
    }

    const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
    res.json({ token, referralCode: code, premiumExpires });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    throw err;
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
  res.json({ token, referralCode: user.referral_code, premiumExpires: user.premium_expires });
});

// Get current user
app.get('/api/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, email, referral_code, premium_expires, referred_by FROM users WHERE id = ?').get(req.user.id);
  const now = Math.floor(Date.now() / 1000);
  const isPremium = user.premium_expires > now;
  const daysLeft = isPremium ? Math.ceil((user.premium_expires - now) / 86400) : 0;

  res.json({
    ...user,
    isPremium,
    daysLeft,
    premiumExpires: user.premium_expires
  });
});

// Redeem referral code
app.post('/api/referral/redeem', authenticate, (req, res) => {
  const { code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (user.referred_by) {
    return res.status(400).json({ error: 'You have already used a referral code' });
  }

  const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
  if (!referrer) return res.status(400).json({ error: 'Invalid code' });
  if (referrer.id === user.id) return res.status(400).json({ error: 'Cannot use your own code' });

  const now = Math.floor(Date.now() / 1000);
  const eightDays = 8 * 24 * 60 * 60;
  const premiumExpires = now + eightDays;

  db.prepare('UPDATE users SET premium_expires = ?, referred_by = ? WHERE id = ?')
    .run(premiumExpires, referrer.id, user.id);

  db.prepare('INSERT INTO redemptions (code, referrer_id, redeemed_by) VALUES (?, ?, ?)')
    .run(code, referrer.id, user.id);

  res.json({ success: true, premiumExpires, daysLeft: 8 });
});

// Referral stats
app.get('/api/referral/stats', authenticate, (req, res) => {
  const redemptions = db.prepare(`
    SELECT r.redeemed_at, u.email 
    FROM redemptions r 
    JOIN users u ON r.redeemed_by = u.id 
    WHERE r.referrer_id = ?
    ORDER BY r.redeemed_at DESC
  `).all(req.user.id);

  res.json({ count: redemptions.length, redemptions });
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

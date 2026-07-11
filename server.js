require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./data.db');

// Promisify helper
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Initialize tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    referral_code TEXT UNIQUE NOT NULL,
    premium_expires INTEGER DEFAULT 0,
    referred_by INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    referrer_id INTEGER NOT NULL,
    redeemed_by INTEGER NOT NULL,
    redeemed_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);
});

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
  try {
    const { email, password, referralCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    
    const hash = await bcrypt.hash(password, 10);
    const code = generateCode();
    
    const result = await dbRun(
      'INSERT INTO users (email, password, referral_code) VALUES (?, ?, ?)',
      [email, hash, code]
    );
    const userId = result.lastID;
    
    let premiumExpires = 0;
    
    if (referralCode) {
      const referrer = await dbGet('SELECT * FROM users WHERE referral_code = ?', [referralCode]);
      if (referrer && referrer.id !== userId) {
        const now = Math.floor(Date.now() / 1000);
        const eightDays = 8 * 24 * 60 * 60;
        premiumExpires = now + eightDays;
        
        await dbRun(
          'UPDATE users SET premium_expires = ?, referred_by = ? WHERE id = ?',
          [premiumExpires, referrer.id, userId]
        );
        
        await dbRun(
          'INSERT INTO redemptions (code, referrer_id, redeemed_by) VALUES (?, ?, ?)',
          [referralCode, referrer.id, userId]
        );
      }
    }
    
    const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
    res.json({ token, referralCode: code, premiumExpires });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
    res.json({ token, referralCode: user.referral_code, premiumExpires: user.premium_expires });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
app.get('/api/me', authenticate, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, email, referral_code, premium_expires, referred_by FROM users WHERE id = ?', [req.user.id]);
    const now = Math.floor(Date.now() / 1000);
    const isPremium = user.premium_expires > now;
    const daysLeft = isPremium ? Math.ceil((user.premium_expires - now) / 86400) : 0;
    
    res.json({
      ...user,
      isPremium,
      daysLeft,
      premiumExpires: user.premium_expires
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Redeem referral code
app.post('/api/referral/redeem', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    
    if (user.referred_by) {
      return res.status(400).json({ error: 'You have already used a referral code' });
    }
    
    const referrer = await dbGet('SELECT * FROM users WHERE referral_code = ?', [code]);
    if (!referrer) return res.status(400).json({ error: 'Invalid code' });
    if (referrer.id === user.id) return res.status(400).json({ error: 'Cannot use your own code' });
    
    const now = Math.floor(Date.now() / 1000);
    const eightDays = 8 * 24 * 60 * 60;
    const premiumExpires = now + eightDays;
    
    await dbRun(
      'UPDATE users SET premium_expires = ?, referred_by = ? WHERE id = ?',
      [premiumExpires, referrer.id, user.id]
    );
    
    await dbRun(
      'INSERT INTO redemptions (code, referrer_id, redeemed_by) VALUES (?, ?, ?)',
      [code, referrer.id, user.id]
    );
    
    res.json({ success: true, premiumExpires, daysLeft: 8 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Referral stats
app.get('/api/referral/stats', authenticate, async (req, res) => {
  try {
    const redemptions = await dbAll(`
      SELECT r.redeemed_at, u.email 
      FROM redemptions r 
      JOIN users u ON r.redeemed_by = u.id 
      WHERE r.referrer_id = ?
      ORDER BY r.redeemed_at DESC
    `, [req.user.id]);
    
    res.json({ count: redemptions.length, redemptions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

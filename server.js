require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const Y = require('yjs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

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

  db.run(`CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    title TEXT DEFAULT 'Untitled',
    icon TEXT DEFAULT '📄',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
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

// Yjs document store for real-time collaboration
const docs = new Map();

function getYDoc(pageId) {
  if (!docs.has(pageId)) {
    const ydoc = new Y.Doc();
    docs.set(pageId, ydoc);
  }
  return docs.get(pageId);
}

wss.on('connection', (ws, req) => {
  const pageId = new URL(req.url, 'http://localhost').searchParams.get('page');
  if (!pageId) return ws.close();

  const ydoc = getYDoc(pageId);
  const awareness = new Y.Awareness(ydoc);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'update') {
        Y.applyUpdate(ydoc, new Uint8Array(data.update));
        // Broadcast to other clients
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', update: data.update }));
          }
        });
      }
    } catch (e) {}
  });

  // Send current state
  const state = Y.encodeStateAsUpdate(ydoc);
  ws.send(JSON.stringify({ type: 'init', update: Array.from(state) }));
});

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

// Auth routes
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

    // Create default workspace
    const wsResult = await dbRun(
      'INSERT INTO workspaces (name, owner_id) VALUES (?, ?)',
      ['My Workspace', userId]
    );

    // Create welcome page
    await dbRun(
      'INSERT INTO pages (workspace_id, title, icon) VALUES (?, ?, ?)',
      [wsResult.lastID, 'Getting Started', '👋']
    );

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

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, email, referral_code, premium_expires, referred_by FROM users WHERE id = ?', [req.user.id]);
    const now = Math.floor(Date.now() / 1000);
    const isPremium = user.premium_expires > now;
    const daysLeft = isPremium ? Math.ceil((user.premium_expires - now) / 86400) : 0;

    res.json({ ...user, isPremium, daysLeft, premiumExpires: user.premium_expires });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Workspace routes
app.get('/api/workspaces', authenticate, async (req, res) => {
  try {
    const workspaces = await dbAll('SELECT * FROM workspaces WHERE owner_id = ?', [req.user.id]);
    res.json(workspaces);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Page routes
app.get('/api/pages', authenticate, async (req, res) => {
  try {
    const { workspace_id } = req.query;
    const pages = await dbAll(
      'SELECT * FROM pages WHERE workspace_id = ? ORDER BY parent_id NULLS FIRST, sort_order',
      [workspace_id]
    );
    res.json(pages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/pages', authenticate, async (req, res) => {
  try {
    const { workspace_id, parent_id, title, icon } = req.body;
    const result = await dbRun(
      'INSERT INTO pages (workspace_id, parent_id, title, icon) VALUES (?, ?, ?, ?)',
      [workspace_id, parent_id || null, title || 'Untitled', icon || '📄']
    );
    res.json({ id: result.lastID, workspace_id, parent_id, title: title || 'Untitled', icon: icon || '📄' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/pages/:id', authenticate, async (req, res) => {
  try {
    const { title, icon } = req.body;
    await dbRun(
      'UPDATE pages SET title = ?, icon = ?, updated_at = strftime('%s', 'now') WHERE id = ?',
      [title, icon, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/pages/:id', authenticate, async (req, res) => {
  try {
    await dbRun('DELETE FROM blocks WHERE page_id = ?', [req.params.id]);
    await dbRun('DELETE FROM pages WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block routes
app.get('/api/blocks/:pageId', authenticate, async (req, res) => {
  try {
    const blocks = await dbAll(
      'SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order',
      [req.params.pageId]
    );
    res.json(blocks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/blocks', authenticate, async (req, res) => {
  try {
    const { page_id, type, content, sort_order } = req.body;
    const result = await dbRun(
      'INSERT INTO blocks (page_id, type, content, sort_order) VALUES (?, ?, ?, ?)',
      [page_id, type || 'text', content || '', sort_order || 0]
    );
    res.json({ id: result.lastID, page_id, type, content, sort_order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/blocks/:id', authenticate, async (req, res) => {
  try {
    const { content, type } = req.body;
    await dbRun(
      'UPDATE blocks SET content = ?, type = ? WHERE id = ?',
      [content, type, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/blocks/:id', authenticate, async (req, res) => {
  try {
    await dbRun('DELETE FROM blocks WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Referral routes
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

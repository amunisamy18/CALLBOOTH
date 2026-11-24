// TogetherBooth — Full-featured server v2.0
// Flat-file storage (Supabase-ready via env flag)
'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MEDIA = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const MAX_PHOTO_ROUNDS = parseInt(process.env.MAX_ROUNDS || '6', 10); // 2-photo to 6-photo strips

fs.mkdirSync(MEDIA, { recursive: true });

// ── Database (flat-file) ──────────────────────────────────────────────────────
let db = { users: [], invite: null, sessions: {}, messages: [], photos: [], gameState: null };
if (fs.existsSync(FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { console.error('Failed to parse data file:', e.message); }
}
const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('Save error', e); }
};
const code = () => crypto.randomBytes(6).toString('hex');

// ── Cookie / session helpers ──────────────────────────────────────────────────
const parseCookies = h => Object.fromEntries(
  (h || '').split(';').map(c => c.trim().split('=')).filter(a => a[0] && a[1]).map(([k, ...v]) => [k, v.join('=')])
);
const userFrom = h => {
  const t = parseCookies(h).sid;
  const id = t && db.sessions[t];
  return id && db.users.find(u => u.id === id) || null;
};

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use((q, r, n) => {
  r.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self)',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' wss: ws:; media-src 'self' blob:; frame-ancestors 'none'"
  });
  n();
});

// Trust proxy for Railway / Render / etc.
app.set('trust proxy', 1);

// Rate limiting
app.use('/api/login', rateLimit({ windowMs: 60000, limit: 15, standardHeaders: true, legacyHeaders: false }));
app.use('/api/register', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/photos', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));

// ── Auth helpers ──────────────────────────────────────────────────────────────
const setSession = (res, u) => {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[t] = u.id;
  // Prune old sessions (keep last 20 per user)
  const entries = Object.entries(db.sessions);
  if (entries.length > 100) {
    const keep = entries.slice(-100);
    db.sessions = Object.fromEntries(keep);
  }
  save();
  res.cookie('sid', t, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.SECURE_COOKIE === '1',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
};

// ── Health check (public, for Railway) ───────────────────────────────────────
app.get('/health', (q, r) => r.json({ ok: true }));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/register', async (q, r) => {
  const { name, password, invite } = q.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 30)
    return r.status(400).json({ error: 'Name is required (max 30 chars).' });
  if (typeof password !== 'string' || password.length < 8)
    return r.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.users.length >= 2)
    return r.status(403).json({ error: 'This booth is full. Only two people allowed.' });
  if (db.users.length === 1 && (!invite || invite.trim() !== db.invite))
    return r.status(403).json({ error: 'Invalid or already-used invite code.' });
  if (db.users.some(u => u.name.toLowerCase() === name.trim().toLowerCase()))
    return r.status(409).json({ error: 'That name is already taken.' });

  const u = {
    id: crypto.randomUUID(),
    name: name.trim(),
    hash: await bcrypt.hash(password, 10),
    color: db.users.length === 0 ? '#e879a8' : '#9b59b6',
    avatar: null,
    createdAt: Date.now()
  };
  db.users.push(u);
  db.invite = db.users.length === 1 ? code() : null;
  setSession(r, u);
  save();
  r.json({ ok: true });
});

app.post('/api/login', async (q, r) => {
  const { name, password } = q.body || {};
  const u = db.users.find(x => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!u || !await bcrypt.compare(String(password || ''), u.hash))
    return r.status(401).json({ error: 'Wrong name or password.' });
  setSession(r, u);
  r.json({ ok: true });
});

const auth = (q, r, n) => {
  const u = userFrom(q.headers.cookie);
  if (!u) return r.status(401).json({ error: 'Not signed in.' });
  q.user = u; n();
};

app.post('/api/logout', auth, (q, r) => {
  delete db.sessions[parseCookies(q.headers.cookie).sid];
  save();
  r.clearCookie('sid', {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.SECURE_COOKIE === '1'
  });
  r.json({ ok: true });
});

app.get('/api/me', auth, (q, r) => {
  r.json({
    me: q.user.id,
    name: q.user.name,
    color: q.user.color,
    users: db.users.map(u => ({ id: u.id, name: u.name, color: u.color })),
    invite: db.users.length < 2 ? db.invite : null
  });
});

app.post('/api/invite', auth, (q, r) => {
  if (db.users.length >= 2) return r.status(403).json({ error: 'Booth is full.' });
  db.invite = code(); save(); r.json({ invite: db.invite });
});

// ── Config route (ICE servers) ────────────────────────────────────────────────
app.get('/api/config', auth, (q, r) => {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ];
  if (process.env.STUN_URL && !servers.some(s => s.urls === process.env.STUN_URL)) {
    servers.unshift({ urls: process.env.STUN_URL });
  }
  if (process.env.TURN_URL) {
    servers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  }
  r.json({ iceServers: servers, maxRounds: MAX_PHOTO_ROUNDS });
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/messages', auth, (q, r) => r.json(db.messages.slice(-300)));

// ── Photos / Gallery ──────────────────────────────────────────────────────────
app.get('/api/photos', auth, (q, r) => r.json(db.photos));

app.post('/api/photos', auth, async (q, r) => {
  const { dataUrl, title, caption, templateId, isFavorite } = q.body || {};
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!m) return r.status(400).json({ error: 'PNG, JPEG, or WebP data URL required.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 12e6) return r.status(413).json({ error: 'Image too large (max 12 MB).' });

  const ext = m[1].replace('jpeg', 'jpg').replace('webp', 'webp');
  const p = {
    id: crypto.randomUUID(),
    title: String(title || 'Memory').slice(0, 80),
    caption: String(caption || '').slice(0, 200),
    templateId: String(templateId || '').slice(0, 40),
    by: q.user.id,
    byName: q.user.name,
    ts: Date.now(),
    ext,
    isFavorite: !!isFavorite
  };
  fs.writeFileSync(path.join(MEDIA, p.id + '.' + ext), buf);
  db.photos.push(p); save();
  io.to('room').emit('gallery', db.photos);
  r.json(p);
});

app.patch('/api/photos/:id', auth, (q, r) => {
  const p = db.photos.find(x => x.id === q.params.id);
  if (!p) return r.sendStatus(404);
  if (typeof q.body.caption === 'string') p.caption = q.body.caption.slice(0, 200);
  if (typeof q.body.title === 'string') p.title = q.body.title.slice(0, 80);
  if (typeof q.body.isFavorite === 'boolean') p.isFavorite = q.body.isFavorite;
  save(); io.to('room').emit('gallery', db.photos); r.json(p);
});

app.delete('/api/photos/:id', auth, (q, r) => {
  const i = db.photos.findIndex(x => x.id === q.params.id);
  if (i < 0) return r.sendStatus(404);
  const [p] = db.photos.splice(i, 1);
  fs.rmSync(path.join(MEDIA, p.id + '.' + p.ext), { force: true });
  save(); io.to('room').emit('gallery', db.photos); r.json({ ok: true });
});

app.get('/media/:id', auth, (q, r) => {
  const p = db.photos.find(x => x.id === q.params.id);
  if (!p) return r.sendStatus(404);
  const fp = path.resolve(MEDIA, p.id + '.' + p.ext);
  if (!fp.startsWith(path.resolve(MEDIA))) return r.sendStatus(400);
  r.sendFile(fp);
});

// ── Game state ────────────────────────────────────────────────────────────────
app.get('/api/game', auth, (q, r) => r.json(db.gameState || null));

app.post('/api/game', auth, (q, r) => {
  if (!q.body || typeof q.body !== 'object') return r.status(400).json({ error: 'Invalid game state.' });
  db.gameState = { ...q.body, updatedAt: Date.now(), updatedBy: q.user.id };
  save(); io.to('room').emit('game:state', db.gameState); r.json(db.gameState);
});

// ── 404 handler for API routes ────────────────────────────────────────────────
app.use('/api', (q, r) => r.status(404).json({ error: 'Not found.' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, q, r, n) => {
  console.error('Unhandled error:', err);
  r.status(500).json({ error: 'Internal server error.' });
});

// ── Socket.IO server ──────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6, pingTimeout: 20000, pingInterval: 10000 });

// In-memory room state
const online = new Map();
let booth = null;

const resetBooth = (keepTemplate) => {
  if (booth?.timer) clearInterval(booth.timer);
  booth = {
    template: keepTemplate || 'classic-white',
    filter: 'none',
    caption: '',
    rounds: 2,
    ready: {},
    shots: [],
    round: 0,
    timer: null,
    running: false,
    phase: 'idle' // idle | countdown | shooting | done
  };
};
resetBooth();

const emitPresence = () => io.to('room').emit('presence', [...online.keys()]);
const emitBoothState = () => io.to('room').emit('booth:state', {
  template: booth.template, filter: booth.filter, caption: booth.caption,
  rounds: booth.rounds, ready: booth.ready, phase: booth.phase, round: booth.round
});

io.use((s, n) => {
  const u = userFrom(s.handshake.headers.cookie);
  if (!u) return n(new Error('unauthorized'));
  s.user = u; n();
});

function startCountdown() {
  booth.running = true;
  booth.phase = 'countdown';
  let c = 3;
  io.to('room').emit('booth:tick', c);
  booth.timer = setInterval(() => {
    c--;
    if (c > 0) {
      io.to('room').emit('booth:tick', c);
    } else {
      clearInterval(booth.timer);
      booth.timer = null;
      booth.phase = 'shooting';
      io.to('room').emit('booth:shoot', booth.round);
    }
  }, 1000);
}

io.on('connection', s => {
  const uid = s.user.id;
  s.join('room');
  online.set(uid, (online.get(uid) || 0) + 1);
  emitPresence();

  // Send current state to newly connected client
  s.emit('booth:state', {
    template: booth.template, filter: booth.filter, caption: booth.caption,
    rounds: booth.rounds, ready: booth.ready, phase: booth.phase, round: booth.round
  });
  if (db.gameState) s.emit('game:state', db.gameState);

  s.on('disconnect', () => {
    const n = (online.get(uid) || 1) - 1;
    n <= 0 ? online.delete(uid) : online.set(uid, n);
    emitPresence();
  });

  // ── WebRTC signaling ──────────────────────────────────────────────────────
  s.on('signal', d => s.to('room').emit('signal', { ...d, from: uid }));
  s.on('hangup', () => s.to('room').emit('hangup', uid));

  // ── Chat ──────────────────────────────────────────────────────────────────
  s.on('typing', () => s.to('room').emit('typing', s.user.name));
  s.on('chat', text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return;
    const m = { id: crypto.randomUUID(), from: uid, fromName: s.user.name, text: text.trim(), ts: Date.now(), type: 'text' };
    db.messages.push(m);
    if (db.messages.length > 1000) db.messages = db.messages.slice(-500);
    save();
    io.to('room').emit('chat', m);
  });
  s.on('chat:reaction', ({ msgId, emoji }) => {
    const m = db.messages.find(x => x.id === msgId);
    if (!m || typeof emoji !== 'string') return;
    m.reactions = m.reactions || {};
    m.reactions[emoji] = (m.reactions[emoji] || 0) + 1;
    save(); io.to('room').emit('chat:reaction', { msgId, emoji, reactions: m.reactions });
  });

  // ── Photo booth ───────────────────────────────────────────────────────────
  s.on('booth:template', t => {
    if (booth.running) return;
    booth.template = String(t).slice(0, 40);
    emitBoothState();
  });
  s.on('booth:filter', f => {
    if (booth.running) return;
    booth.filter = String(f).slice(0, 100);
    emitBoothState();
  });
  s.on('booth:caption', c => {
    booth.caption = String(c || '').slice(0, 60);
    emitBoothState();
  });
  s.on('booth:rounds', n => {
    if (booth.running) return;
    const rounds = Math.min(Math.max(parseInt(n, 10) || 2, 1), MAX_PHOTO_ROUNDS);
    booth.rounds = rounds;
    emitBoothState();
  });
  s.on('booth:ready', v => {
    if (booth.running) return;
    booth.ready[uid] = !!v;
    emitBoothState();
    const allReady = db.users.length === 2 && db.users.every(u => booth.ready[u.id]);
    if (allReady) {
      booth.shots = [];
      booth.round = 0;
      startCountdown();
    }
  });
  s.on('booth:cancel', () => {
    const t = booth.template;
    resetBooth(t);
    emitBoothState();
    io.to('room').emit('booth:cancelled');
  });
  s.on('booth:shot', ({ round, img }) => {
    if (!booth.running || round !== booth.round) return;
    if (typeof img !== 'string' || !img.startsWith('data:image/jpeg;base64,')) return;
    booth.shots[round] = booth.shots[round] || {};
    booth.shots[round][uid] = img;

    const allShot = db.users.every(u => booth.shots[round]?.[u.id]);
    if (allShot) {
      booth.round++;
      if (booth.round < booth.rounds) {
        booth.phase = 'countdown';
        setTimeout(() => startCountdown(), 800); // brief pause between shots
      } else {
        // Build frames: each round has photos from each user interleaved
        const frames = booth.shots.flatMap(r => db.users.map(u => r[u.id]));
        const t = booth.template;
        const f = booth.filter;
        const c = booth.caption;
        resetBooth(t);
        booth.filter = f;
        booth.caption = c;
        io.to('room').emit('booth:done', { frames, template: t, filter: f, caption: c });
        emitBoothState();
      }
    }
  });

  // ── Game state sync ───────────────────────────────────────────────────────
  s.on('game:update', state => {
    db.gameState = { ...state, updatedAt: Date.now(), updatedBy: uid };
    save();
    s.to('room').emit('game:state', db.gameState);
  });
  s.on('game:reset', () => {
    db.gameState = null;
    save();
    io.to('room').emit('game:state', null);
  });

  // ── Drawing board ─────────────────────────────────────────────────────────
  s.on('draw', d => s.to('room').emit('draw', { ...d, from: uid }));
  s.on('draw:clear', () => io.to('room').emit('draw:clear'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  server.listen(PORT, () => console.log(`TogetherBooth v2 running at http://localhost:${PORT}`));
}
module.exports = { server, io };

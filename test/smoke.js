// TogetherBooth v2 — Integration smoke test
// Two authenticated clients, room limit, chat, synchronized booth, gallery persistence.
const os = require('os');
const path = require('path');
const tmpDir = os.tmpdir();
process.env.PORT = 0;
process.env.DATA_FILE = path.join(tmpDir, 'tb-test.json');
process.env.MEDIA_DIR = path.join(tmpDir, 'tb-media-test');

const fs = require('fs');
if (fs.existsSync(process.env.DATA_FILE)) fs.rmSync(process.env.DATA_FILE, { force: true });

const { server } = require('../server');
const { io: cli } = require('socket.io-client');
const assert = require('assert');

// Minimal valid JPEG (1x1 pixel)
const jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;

  const post = async (u, b, ck) => {
    const r = await fetch(base + u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ck || '' },
      body: JSON.stringify(b)
    });
    return { s: r.status, ck: (r.headers.get('set-cookie') || '').split(';')[0], j: await r.json() };
  };

  // --- Registration ---
  const A = await post('/api/register', { name: 'Asha', password: 'password1' });
  assert.equal(A.s, 200, 'A registers OK');

  const me = await (await fetch(base + '/api/me', { headers: { cookie: A.ck } })).json();
  assert(me.invite, 'Invite code generated for first user');

  // Bad invite rejected
  assert.equal((await post('/api/register', { name: 'Eve', password: 'password1', invite: 'bad' })).s, 403, 'Bad invite blocked');

  // Second user registers with valid invite
  const B = await post('/api/register', { name: 'Ravi', password: 'password1', invite: me.invite });
  assert.equal(B.s, 200, 'B registers OK with valid invite');

  // Third user always blocked
  assert.equal((await post('/api/register', { name: 'Zed', password: 'password1', invite: me.invite })).s, 403, 'Third user blocked');

  // Wrong password rejected
  assert.equal((await post('/api/login', { name: 'Asha', password: 'wrongpass' })).s, 401, 'Wrong password rejected');

  // Unauthenticated access blocked
  assert.equal((await fetch(base + '/api/messages')).status, 401, 'Unauth message access blocked');

  // Unauthorized socket connection rejected
  await new Promise(r => { const x = cli(base, { extraHeaders: {} }); x.on('connect_error', () => { x.close(); r(); }); });
  console.log('✅ Auth tests passed');

  // --- Socket connections ---
  const sa = cli(base, { extraHeaders: { cookie: A.ck } });
  const sb = cli(base, { extraHeaders: { cookie: B.ck } });
  await Promise.all([sa, sb].map(s => new Promise(r => s.on('connect', r))));
  console.log('✅ Both sockets connected');

  // --- Chat ---
  const chatReceived = new Promise(r => sb.on('chat', r));
  sa.emit('chat', 'hello from Asha');
  const chatMsg = await chatReceived;
  assert.equal(chatMsg.text, 'hello from Asha', 'Chat message delivered');
  assert(chatMsg.id, 'Chat message has ID');
  assert(chatMsg.ts, 'Chat message has timestamp');
  console.log('✅ Chat test passed');

  // --- WebRTC signal relay ---
  const sig = new Promise(r => sb.on('signal', r));
  sa.emit('signal', { desc: { type: 'offer', sdp: 'v=0\r\n' } });
  const sigReceived = await sig;
  assert.equal(sigReceived.desc.type, 'offer', 'Signal relayed');
  console.log('✅ Signal relay test passed');

  // --- Photo booth (2 rounds) ---
  const doneA = new Promise(r => sa.on('booth:done', r));
  const doneB = new Promise(r => sb.on('booth:done', r));
  let ticks = 0;
  for (const s of [sa, sb]) {
    s.on('booth:tick', () => ticks++);
    s.on('booth:shoot', round => s.emit('booth:shot', { round, img: jpg }));
  }
  sa.emit('booth:ready', true);
  sb.emit('booth:ready', true);
  const framesA = await doneA;
  const framesB = await doneB;
  assert.equal(framesA.frames.length, 4, 'Both frames received by A (2 rounds × 2 users)');
  assert.equal(framesB.frames.length, 4, 'Both frames received by B');
  assert(ticks >= 6, `At least 6 ticks (got ${ticks})`);
  console.log('✅ Photo booth test passed');

  // --- Gallery ---
  const ph = await post('/api/photos', { dataUrl: png, title: 'Test Memory' }, A.ck);
  assert.equal(ph.s, 200, 'Photo saved');
  assert(ph.j.id, 'Photo has ID');

  // Bad data URL rejected
  assert.equal((await post('/api/photos', { dataUrl: 'data:text/html;base64,AAA' }, A.ck)).s, 400, 'Bad MIME rejected');

  // Unauthenticated media access blocked
  assert.equal((await fetch(base + '/media/' + ph.j.id)).status, 401, 'Unauth media blocked');

  // Authenticated access works
  assert.equal((await fetch(base + '/media/' + ph.j.id, { headers: { cookie: B.ck } })).status, 200, 'Auth media access OK');

  // Persistence after re-login
  const relogin = await post('/api/login', { name: 'Asha', password: 'password1' });
  const photos = await (await fetch(base + '/api/photos', { headers: { cookie: relogin.ck } })).json();
  assert(photos.length >= 1, 'Photos persist after re-login');
  console.log('✅ Gallery persistence test passed');

  // --- Booth template sync ---
  const statePromise = new Promise(r => sb.on('booth:state', r));
  sa.emit('booth:template', 'pink-soft');
  const newState = await statePromise;
  assert.equal(newState.template, 'pink-soft', 'Template synced to B');
  console.log('✅ Template sync test passed');

  sa.close(); sb.close();
  server.close(() => {
    console.log('\n🎉 ALL SMOKE TESTS PASSED ✅');
    process.exit(0);
  });
})().catch(e => {
  console.error('\n❌ FAIL:', e.message || e);
  process.exit(1);
});

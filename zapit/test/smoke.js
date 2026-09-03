#!/usr/bin/env node
/**
 * ZapIt smoke test — boots the server on an ephemeral port and exercises:
 *   - static pages + JSON endpoints
 *   - two clients joining a room and exchanging presence
 *   - a real binary file streamed through the relay (chunked) to the other peer
 *   - admin login + auth kill-switch toggle (persisted to disk, restored after)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 15150;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${p}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
// like get() but against an arbitrary local port (used for second server instances)
function get2(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function post(p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const msgs = [];
    const waiters = []; // { type, resolve, timer }
    const binChunks = [];

    function dispatch(m) {
      const i = waiters.findIndex((w) => !w.type || w.type === m.type);
      if (i !== -1) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
      } else {
        msgs.push(m);
      }
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) { binChunks.push(data); return; }
      dispatch(JSON.parse(data.toString()));
    });
    ws.on('open', () => resolve({
      ws, binChunks,
      next: (type, timeout = 4000) => new Promise((res2, rej2) => {
        const idx = msgs.findIndex((m) => !type || m.type === type);
        if (idx !== -1) return res2(msgs.splice(idx, 1)[0]);
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === res2);
          if (i !== -1) waiters.splice(i, 1);
          rej2(new Error(`timeout waiting for ${type || 'any message'}`));
        }, timeout);
        waiters.push({ type, resolve: res2, timer });
      }),
      send: (obj) => ws.send(JSON.stringify(obj)),
      sendBin: (buf) => ws.send(buf, { binary: true }),
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapit-test-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ZAPIT_DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'test-admin-pw',
      PUBLIC_URL: 'https://zapit.example.test',
      // fake provider config: only needs to exist so the auth toggle is permitted
      AUTHENTIK_BASE_URL: 'http://127.0.0.1:9',
      AUTHENTIK_CLIENT_ID: 'zapit-test-client',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    // wait for listen
    for (let i = 0; i < 50; i++) {
      try { await get('/healthz'); break; } catch { await sleep(100); }
    }

    console.log('▶ static & api');
    const idx = await get('/');
    ok('GET / serves index', idx.status === 200 && idx.body.includes('zapit'));
    const admin = await get('/admin');
    ok('GET /admin serves admin page', admin.status === 200 && admin.body.includes('admin'));
    const cfg = await get('/api/config');
    ok('GET /api/config', cfg.status === 200 && JSON.parse(cfg.body).authEnabled === false);
    const lan = await get('/api/lan');
    const lanJ = JSON.parse(lan.body);
    ok('GET /api/lan includes QR data URL', lan.status === 200 && lanJ.qr.startsWith('data:image/png;base64,'));
    ok('/api/lan uses PUBLIC_URL for QR/self', lanJ.selfUrl === 'https://zapit.example.test' && lanJ.addresses[0].url === 'https://zapit.example.test');
    ok('/api/lan QR encodes PUBLIC_URL by default', lanJ.qrUrl === 'https://zapit.example.test');

    console.log('▶ authentik blueprint generator');
    const bpRes = await get('/api/authentik/blueprint');
    const bpText = bpRes.body.toString('utf8');
    let bp = null;
    try {
      // authentik blueprints use custom YAML tags (!Find, !KeyOf, !Env) — strip them so
      // the doc loads with a plain parser; tag payloads remain as strings for assertions
      const stripped = bpText.replace(/(^|\s)!([A-Za-z][\w.-]*)/g, '$1');
      bp = require('js-yaml').load(stripped);
    } catch {}
    ok('blueprint returns valid YAML', bpRes.status === 200 && !!bp);
    ok('blueprint creates OAuth2 provider + application',
      bp && bp.entries && bp.entries.length === 2 &&
      bp.entries[0].model === 'authentik_providers_oauth2.oauth2provider' &&
      bp.entries[1].model === 'authentik_core.application');
    ok('blueprint provider is public/PKCE client with expected client_id',
      bp && bp.entries[0].attrs.client_type === 'public' && bp.entries[0].attrs.client_id === 'zapit-test-client');
    ok('blueprint redirect URI derives from PUBLIC_URL',
      bp && bp.entries[0].attrs.redirect_uris[0].url === 'https://zapit.example.test/api/auth/callback');
    ok('blueprint links application via !KeyOf',
      bp && bp.entries[1].attrs.provider === 'zapit-provider' && bp.entries[0].id === 'zapit-provider');

    console.log('▶ QR_URL override (custom QR link address)');
    // third server run: QR_URL set → QR must encode it, everything else unchanged
    try {
      const server3 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: {
          ...process.env,
          PORT: String(PORT + 2),
          HOST: '127.0.0.1',
          ZAPIT_DATA_DIR: dataDir,
          ADMIN_PASSWORD: 'x',
          PUBLIC_URL: 'https://zapit.example.test',
          QR_URL: 'https://join.example.org/pick-a-room',
        },
        stdio: 'ignore',
      });
      let up3 = false;
      for (let i = 0; i < 50; i++) { try { await get2(PORT + 2, '/healthz'); up3 = true; break; } catch { await sleep(100); } }
      const lan3 = JSON.parse((await get2(PORT + 2, '/api/lan')).body);
      ok('QR_URL overrides the encoded address', up3 && lan3.qrUrl === 'https://join.example.org/pick-a-room');
      ok('QR_URL leaves selfUrl/addresses alone', up3 && lan3.selfUrl === 'https://zapit.example.test' && lan3.addresses[0].url === 'https://zapit.example.test');
      ok('QR image still a PNG data URL', up3 && lan3.qr.startsWith('data:image/png;base64,'));
      server3.kill('SIGTERM');
    } catch (e) { ok('QR_URL override works', false, e.message); }
    try {
      // second server run: no PUBLIC_URL → endpoint must refuse
      const server2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: { ...process.env, PORT: String(PORT + 1), HOST: '127.0.0.1', ZAPIT_DATA_DIR: dataDir, ADMIN_PASSWORD: 'x' },
        stdio: 'ignore',
      });
      let up = false;
      for (let i = 0; i < 50; i++) { try { await get2(PORT + 1, '/healthz'); up = true; break; } catch { await sleep(100); } }
      const noBp = await get2(PORT + 1, '/api/authentik/blueprint');
      ok('blueprint endpoint refuses without PUBLIC_URL (400)', up && noBp.status === 400);
      server2.kill('SIGTERM');
    } catch (e) { ok('blueprint endpoint refuses without PUBLIC_URL (400)', false, e.message); }

    console.log('▶ websocket room pairing');
    const a = await wsClient();
    a.send({ type: 'join', room: 'test-room' });
    const joined = await a.next('joined');
    ok('client A joined room', joined.room === 'test-room');
    ok('joined carries yourId', Number.isFinite(joined.yourId) && joined.yourId > 0);

    const b = await wsClient();
    b.send({ type: 'join', room: 'test-room' });
    await b.next('joined');
    a.send({ type: 'hello', name: 'sender' });
    b.send({ type: 'hello', name: 'receiver' });
    const infoOnB = await b.next('peer-info');
    ok('B learns about A (peer-info)', infoOnB.name === 'sender' && Number.isFinite(infoOnB.id));
    // A gets one peer-info from its own hello (B not yet hello'd -> 'device') and
    // a second one from B's hello ('receiver') — consume both
    await a.next('peer-info');
    const infoOnA = await a.next('peer-info');
    ok('A learns about B (peer-info)', infoOnA.name === 'receiver' && Number.isFinite(infoOnA.id));

    console.log('▶ binary file transfer through relay');
    const payload = crypto.randomBytes(1024 * 1024); // 1 MiB
    const fromId = infoOnB.id;
    b.send({ type: 'file-meta', name: 'blob.bin', size: payload.length, mime: 'application/octet-stream', tid: 7, index: 0, path: 'docs/blob.bin', count: 1 });
    const metaOnA = await a.next('file-meta');
    ok('A received file-meta', metaOnA.name === 'blob.bin' && metaOnA.size === payload.length);
    ok('file-meta carries tid/index/path', metaOnA.tid === 7 && metaOnA.index === 0 && metaOnA.path === 'docs/blob.bin');

    const CHUNK = 256 * 1024;
    for (let off = 0; off < payload.length; off += CHUNK) {
      const chunk = payload.subarray(off, Math.min(off + CHUNK, payload.length));
      const pkt = Buffer.alloc(8 + chunk.length);
      pkt.writeUInt32BE(fromId, 0);
      pkt.writeUInt32BE(1, 4); // transfer id
      chunk.copy(pkt, 8);
      a.sendBin(pkt);
    }
    a.send({ type: 'file-done', tid: 7 });

    const deadline = Date.now() + 5000;
    while (b.binChunks.reduce((s, c) => s + c.length, 0) < payload.length && Date.now() < deadline) await sleep(50);
    const received = Buffer.concat(b.binChunks.map((c) => Buffer.from(c)));
    // reassemble by scanning packets: each packet = 8-byte header + payload; sizes known from chunking
    const payloads = [];
    const sizes = [];
    for (let off = 0; off < payload.length; off += CHUNK) sizes.push(Math.min(CHUNK, payload.length - off));
    let pos = 0;
    for (const s of sizes) {
      payloads.push(Buffer.from(received.subarray(pos + 8, pos + 8 + s)));
      pos += 8 + s;
    }
    const rebuilt = Buffer.concat(payloads);
    ok('binary payload intact after relay', rebuilt.equals(payload), `got ${rebuilt.length} bytes`);

    const doneOnB = await b.next('file-done');
    ok('B got file-done with tid', !!doneOnB && doneOnB.tid === 7);

    console.log('▶ p2p signaling relay (ring/ringing)');
    a.send({ type: 'ring', to: infoOnA.id });
    const ringOnB = await b.next('ring');
    ok('B got ring from A', ringOnB.from === fromId);
    b.send({ type: 'ringing', to: ringOnB.from });
    const ringingOnA = await a.next('ringing');
    ok('A got ringing from B', ringingOnA.from === infoOnA.id);

    console.log('▶ admin & kill-switch');
    const badLogin = await post('/api/admin/login', { password: 'wrong' });
    ok('admin login rejects wrong password', badLogin.status === 403);
    const goodLogin = await post('/api/admin/login', { password: 'test-admin-pw' });
    ok('admin login returns token', goodLogin.status === 200 && JSON.parse(goodLogin.body).token);
    const token = JSON.parse(goodLogin.body).token;
    const auth = { Authorization: `Bearer ${token}` };

    const t0 = JSON.parse((await get('/api/admin/state', auth)).body);
    ok('admin state read', t0.authEnabled === false);

    const toggleOn = await post('/api/admin/auth-toggle', { authEnabled: true }, auth);
    ok('toggle ON', toggleOn.status === 200 && JSON.parse(toggleOn.body).authEnabled === true);

    const stateFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    ok('kill-switch persisted to state.json', stateFile.authEnabled === true);

    // unauthenticated WS now refused
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
    });
    ok('unauthenticated websocket refused when auth ON', refused === true);

    // /api/config reflects auth requirement
    const cfg2 = JSON.parse((await get('/api/config')).body);
    ok('/api/config shows authEnabled', cfg2.authEnabled === true && cfg2.authenticated === false);

    const toggleOff = await post('/api/admin/auth-toggle', { authEnabled: false }, auth);
    ok('toggle OFF', toggleOff.status === 200 && JSON.parse(toggleOff.body).authEnabled === false);

    const reconnect = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    ok('websocket allowed again after toggle OFF', reconnect === true);

    a.close(); b.close();
  } catch (e) {
    failed++;
    console.error('  ✘ unexpected failure:', e.message);
    console.error(serverLog.slice(-2000));
  } finally {
    server.kill('SIGTERM');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();

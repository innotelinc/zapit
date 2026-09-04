#!/usr/bin/env node
/**
 * browser-sim.js — drives the REAL zapit UI (public/index.html) in jsdom "tabs".
 *
 * Real:  the actual server, the actual index.html script, actual Blob/File slicing,
 *        ZIP building, chunking, backpressure, room expiry, WebSocket signaling
 *        (bridged to the real server over the ws lib).
 * Shimmed transports only: RTCPeerConnection is a local implementation with the same
 *        API — data channels genuinely pair up and carry the same bytes, just in-process.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 15160;
const BASE = `http://127.0.0.1:${PORT}`;
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------- WebRTC shim: local RTCPeerConnection pair ------------- */

const LIVE_PCS = new Set();

class DataChannelShim {
  constructor() {
    this.readyState = 'connecting';
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onbufferedamountlow = null;
    this._peer = null;
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('dc not open');
    const size = typeof data === 'string' ? data.length : (data.byteLength ?? data.size ?? 0);
    this.bufferedAmount += size;
    setTimeout(() => {
      const pair = this._peer;
      if (!pair || pair.readyState !== 'open') return;
      // deliver binary as a node-realm ArrayBuffer (like the ws shim does) —
      // jsdom Blobs can't wrap ArrayBuffers from *other jsdom realms*
      const copy = typeof data === 'string' ? data : new Uint8Array(Buffer.from(data)).buffer;
      if (pair.onmessage) pair.onmessage({ data: copy });
      this.bufferedAmount = Math.max(0, this.bufferedAmount - size);
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold && this.onbufferedamountlow) this.onbufferedamountlow();
    }, 0);
  }
  close() { this.readyState = 'closed'; if (this._peer) this._peer.readyState = 'closed'; }
}

class RPCShim {
  constructor() {
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
    this._dc = null;
    this._paired = false;
    LIVE_PCS.add(this);
  }
  createDataChannel() {
    this._dc = new DataChannelShim();
    return this._dc;
  }
  async createOffer() { return { type: 'offer', sdp: `offer-${Math.random().toString(36).slice(2)}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer-${Math.random().toString(36).slice(2)}` }; }
  async setLocalDescription() {}
  async setRemoteDescription() { setTimeout(() => this._complete(), 0); }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; LIVE_PCS.delete(this); }
  _complete() {
    if (this._paired) return;
    // find the other live PC (each sim realm has at most one)
    const partner = [...LIVE_PCS].find((x) => x !== this && !x._paired && x._dc);
    if (!partner || !partner._dc) return;
    this._paired = true; partner._paired = true;

    const a = this._dc;
    let b = partner._dc;
    // answerer learns of its channel via ondatachannel (real API behavior)
    if (partner === this || !b) {
      b = new DataChannelShim();
      partner._dc = b;
      if (partner.ondatachannel) partner.ondatachannel({ channel: b });
    }
    // if THIS side is the answerer (no _dc yet), create ours and fire ondatachannel
    if (!a) {
      const mine = new DataChannelShim();
      this._dc = mine;
      if (this.ondatachannel) this.ondatachannel({ channel: mine });
      this._completePair(mine, b);
      return;
    }
    this._completePair(a, b);
  }
  _completePair(a, b) {
    a._peer = b; b._peer = a;
    a.readyState = 'open'; b.readyState = 'open';
    this.connectionState = 'open';
    const other = LIVE_PCS.size ? [...LIVE_PCS].find((x) => x !== this && x._paired) : null;
    if (other) other.connectionState = 'open';
    if (a.onopen) a.onopen({});
    if (b.onopen) b.onopen({});
    if (this.onconnectionstatechange) this.onconnectionstatechange();
    if (other && other.onconnectionstatechange) other.onconnectionstatechange();
  }
}

/* ------------- jsdom tab factory ------------- */

function makeTab(name, room = 'simroom', opts = {}) {
  // opts: { ua: '...' , standalone: bool } — lets tests exercise iOS install paths
  const vc = new VirtualConsole();
  vc.on('error', (...a) => console.error(`[${name} console.error]`, ...a));
  vc.on('jsdomError', (e) => console.error(`[${name} jsdomError]`, e.message, e.detail && e.detail.stack ? `\n${e.detail.stack}` : ''));
  const dom = new JSDOM(HTML, {
    url: `${BASE}/?room=${room}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.zapitSim = true; // IS_SIM: small chunks, fast room expiry
      window.fetch = (input, init) => fetch(String(input).startsWith('http') ? input : `${BASE}${input}`, init);
      // jsdom provides a real origin-scoped localStorage — no shim needed
      Object.defineProperty(window.navigator, 'userAgent', {
        value: opts.ua || `Mozilla/5.0 ${name} TestBrowser/1.0`, configurable: true,
      });
      if (opts.standalone) {
        try { Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true }); } catch {}
      }
      window.__sockets = [];
      window.WebSocket = class {
        constructor(url) {
          this.url = url;
          this.readyState = 0;
          this.bufferedAmount = 0;
          this._ws = new WebSocket(url);
          this._ws.binaryType = 'nodebuffer';
          window.__sockets.push(this);
          this._ws.on('open', () => { this.readyState = 1; if (this.onopen) this.onopen({}); });
          this._ws.on('message', (data, isBin) => {
            if (isBin) { if (this.onmessage) this.onmessage({ data: new Uint8Array(data).buffer }); return; }
            if (this.onmessage) this.onmessage({ data: data.toString() });
          });
          this._ws.on('close', () => { this.readyState = 3; if (this.onclose) this.onclose({}); });
          this._ws.on('error', (e) => { if (this.onerror) this.onerror(e); });
        }
        send(d) {
          if (typeof d === 'string') return this._ws.send(d);
          this._ws.send(Buffer.isBuffer(d) ? d : Buffer.from(d.buffer ?? d));
        }
        close() { this._ws.close(); }
      };
      window.RTCPeerConnection = class extends RPCShim {};
      if (!window.Blob.prototype.arrayBuffer) {
        window.Blob.prototype.arrayBuffer = function () {
          return new Promise((res, rej) => {
            const fr = new window.FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = () => rej(fr.error);
            fr.readAsArrayBuffer(this);
          });
        };
      }
      window.URL.createObjectURL = (blob) => {
        const u = `blob:sim-${tab._blobs.length}`;
        tab._blobs.push({ u, blob });
        return u;
      };
      window.URL.revokeObjectURL = () => {};
      window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const tab = { dom, w: dom.window, _blobs: [] };
  return tab;
}

/* ------------- helpers ------------- */

function waitFor(fn, timeout = 6000, what = 'condition') {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let good = false;
      try { good = fn(); } catch {}
      if (good) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`timeout: ${what}`)); }
    }, 40);
  });
}
const makeFile = (w, name, bytes, mime) => new w.File([Buffer.from(bytes)], name, { type: mime || 'application/octet-stream' });
const rows = (w) => [...w.document.querySelectorAll('#transfers .t')];
const rowNamed = (w, name) => rows(w).find((r) => r.querySelector('.name').textContent === name);

/* ------------- main ------------- */

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapit-sim-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ZAPIT_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/healthz`); break; } catch { await sleep(100); } }

  try {
    const A = makeTab('A');
    const B = makeTab('B');
    await sleep(200);

    console.log('▶ pairing');
    await waitFor(() => A.w.document.getElementById('statusText').textContent.includes('paired'), 5000, 'A paired');
    await waitFor(() => B.w.document.getElementById('statusText').textContent.includes('paired'), 5000, 'B paired');
    ok('both tabs paired into the same room', true);

    console.log('▶ p2p negotiation (ring → offer → answer → channel)');
    await waitFor(() => A.w.document.querySelector('#modeTag').textContent.includes('p2p') ||
                       B.w.document.querySelector('#modeTag').textContent.includes('p2p'), 8000, 'p2p channel open');
    ok('WebRTC data channel negotiated between tabs', true);

    console.log('▶ p2p single-file transfer (A → B) with byte verification');
    const payload = crypto.randomBytes(512 * 1024);
    A.w.__zapitSend([makeFile(A.w, 'hello.bin', payload)]);
    await waitFor(() => {
      const r = rowNamed(B.w, 'hello.bin');
      return r && r.classList.contains('done');
    }, 10000, 'B received hello.bin');
    ok('B completed p2p transfer of hello.bin', true);
    const saveBtn = rowNamed(B.w, 'hello.bin').querySelector('.acts button');
    saveBtn.click();
    await waitFor(() => B._blobs.some((b) => b.blob.size === payload.length), 3000, 'blob captured');
    const got = B._blobs.find((b) => b.blob.size === payload.length);
    ok('received bytes identical to sent bytes', Buffer.from(await got.blob.arrayBuffer()).equals(payload));

    console.log('▶ p2p multi-file drop → single ZIP on receiver');
    const files = [
      makeFile(A.w, 'one.txt', Buffer.from('file number one'), 'text/plain'),
      makeFile(A.w, 'two.txt', Buffer.from('file number two!'), 'text/plain'),
      makeFile(A.w, 'three.bin', crypto.randomBytes(64 * 1024)),
    ];
    A.w.__zapitSend(files);
    await waitFor(() => rows(B.w).some((r) => r.querySelector('.name').textContent === 'zapit-2.zip' && r.classList.contains('done')), 10000, 'B received zip');
    const zipRow = rows(B.w).find((r) => r.querySelector('.name').textContent === 'zapit-2.zip');
    ok('receiver got one ZIP for the 3-file drop', !!zipRow);
    zipRow.querySelector('.acts button').click();
    await waitFor(() => B._blobs.some((b) => b.blob.size > 64 * 1024 + 200), 3000, 'zip blob captured');
    const zipEntry = B._blobs[B._blobs.length - 1];
    const zipBuf = Buffer.from(await zipEntry.blob.arrayBuffer());
    ok('zip magic bytes (PK)', zipBuf[0] === 0x50 && zipBuf[1] === 0x4b);
    ok('zip contains one.txt', zipBuf.includes(Buffer.from('one.txt')));
    ok('zip contains two.txt', zipBuf.includes(Buffer.from('two.txt')));
    const idx = zipBuf.indexOf(Buffer.from('one.txt'));
    const lhStart = idx - 30;
    const nameLen = zipBuf.readUInt16LE(lhStart + 26);
    const dataSize = zipBuf.readUInt32LE(lhStart + 18);
    const dataStart = lhStart + 30 + nameLen;
    ok('zip entry payload intact', zipBuf.subarray(dataStart, dataStart + dataSize).equals(Buffer.from('file number one')));

    console.log('▶ zing zap (A → B)');
    A.w.document.getElementById('txtOut').value = 'sim says hi';
    A.w.document.getElementById('sendTxt').click();
    await waitFor(() => B.w.document.getElementById('txtIn').value === 'sim says hi', 5000, 'text arrived');
    ok('zing zap delivered', true);

    console.log('▶ relay fallback (RTC disabled → through server)');
    A.w.__forceRelay = true;
    B.w.__forceRelay = true;
    const relayPayload = crypto.randomBytes(256 * 1024);
    A.w.__zapitSend([makeFile(A.w, 'relay.bin', relayPayload)]);
    await waitFor(() => {
      const r = rowNamed(B.w, 'relay.bin');
      return r && r.classList.contains('done');
    }, 10000, 'relay transfer done');
    ok('relay-mode transfer works', true);
    const relayBtn = rowNamed(B.w, 'relay.bin').querySelector('.acts button');
    relayBtn.click();
    await waitFor(() => B._blobs.some((b) => b.blob.size === relayPayload.length), 3000, 'relay blob captured');
    const relayGot = B._blobs.find((b) => b.blob.size === relayPayload.length);
    ok('relay bytes identical too', Buffer.from(await relayGot.blob.arrayBuffer()).equals(relayPayload));

    console.log('▶ room expiry + rotation');
    await waitFor(() => A.w.document.getElementById('expiry').textContent.includes('locked'), 3000, 'expiry paused while paired');
    ok('expiry indicator shows locked-while-paired', true);
    A.w.__forceRelay = false; B.w.__forceRelay = false;
    for (const s of B.w.__sockets) { try { s._ws.close(); } catch {} }
    B.dom.window.close();
    await waitFor(() => A.w.document.getElementById('statusText').textContent.includes('alone'), 8000, 'A sees peer leave');
    ok('A back to solo after peer left', true);
    await waitFor(() => {
      const v = A.w.document.getElementById('room').value;
      return v && v !== 'simroom';
    }, 8000, 'room code rotated');
    ok('room code auto-rotated when idle', true);

    console.log('▶ leave room (explicit disconnect)');
    const C = makeTab('C', 'leaveroom');
    const D = makeTab('D', 'leaveroom');
    await sleep(250);
    await waitFor(() => C.w.document.getElementById('statusText').textContent.includes('paired'), 5000, 'C paired');
    await waitFor(() => D.w.document.getElementById('statusText').textContent.includes('paired'), 5000, 'D paired');
    ok('leave-room tabs paired', true);
    const dLeave = D.w.document.getElementById('leaveBtn');
    ok('Leave button is visible while connected', !dLeave.classList.contains('hidden'));
    dLeave.click();
    await waitFor(() => D.w.document.getElementById('statusText').textContent.includes('Left the room'), 3000, 'D status flips to left');
    ok('D disconnects and status confirms', true);
    ok('Leave button hides after leaving', dLeave.classList.contains('hidden'));
    ok('rotation controls reset after leaving',
      D.w.document.getElementById('rotateBtn').classList.contains('hidden') &&
      D.w.document.getElementById('expiry').textContent === '');
    ok('room param dropped from the URL after leaving', !D.w.location.search.includes('room='));
    await waitFor(() => C.w.document.getElementById('statusText').textContent.includes('alone'), 5000, 'C sees D leave');
    ok('C sees peer leave after D disconnects', true);
    // D rejoins a fresh room to prove pairing still works after a leave
    C.w.document.getElementById('room').value = 'rejoinroom';
    C.w.document.getElementById('joinBtn').click();
    D.w.document.getElementById('room').value = 'rejoinroom';
    D.w.document.getElementById('joinBtn').click();
    await waitFor(() => {
      const ct = C.w.document.getElementById('statusText').textContent;
      const dt = D.w.document.getElementById('statusText').textContent;
      return /paired/i.test(ct) && /paired/i.test(dt);
    }, 8000, 'both rejoined a new room');
    ok('D can rejoin a room after leaving', true);
    ok('Leave button visible again after rejoining', !D.w.document.getElementById('leaveBtn').classList.contains('hidden'));
    await sleep(500); // let pending p2p-open timers fire before the tabs close
    C.dom.window.close(); D.dom.window.close();
    await sleep(100);

    console.log('▶ iOS install guidance (no beforeinstallprompt on iPhone)');
    const iosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const iosTab = makeTab('iosSafari', 'iosroom', { ua: iosUA });
    await sleep(250);
    const iosInstall = iosTab.w.document.getElementById('installBtn');
    ok('iPhone Safari shows the Install button', iosInstall.classList.contains('visible'));
    iosInstall.click();
    await waitFor(() => iosTab.w.document.getElementById('installModal').classList.contains('show'), 2000, 'install help modal');
    ok('iPhone install tap opens the Add-to-Home-Screen guide', true);
    iosTab.w.document.getElementById('installClose').click();
    ok('install guide closes via its ✕', !iosTab.w.document.getElementById('installModal').classList.contains('show'));
    iosTab.dom.window.close();
    const installedTab = makeTab('iosStandalone', 'iosroom2', { ua: iosUA, standalone: true });
    await sleep(250);
    ok('iOS running standalone hides the Install button',
      !installedTab.w.document.getElementById('installBtn').classList.contains('visible'));
    installedTab.dom.window.close();
  } catch (e) {
    failed++;
    console.error('  ✘ unexpected failure:', e.stack || e.message);
  } finally {
    server.kill('SIGTERM');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

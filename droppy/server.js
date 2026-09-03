#!/usr/bin/env node
/**
 * Droppy — drag & drop file transfer between devices (web / LAN).
 *
 * No accounts: open the URL, type or scan the room code, drop files.
 * Optional Authentik SSO (OIDC, PKCE) and an admin kill-switch.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

/* ---------------------------------------------------------------- config */

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  if (i !== -1 && i + 1 < args.length) return args[i + 1];
  const prefix = `--${name}=`;
  const withEq = args.find((a) => a.startsWith(prefix));
  return withEq ? withEq.slice(prefix.length) : undefined;
}

const PORT = parseInt(argValue('port') || process.env.PORT || '5150', 10);
const HOST = argValue('host') || process.env.HOST || '0.0.0.0';

// env-parse helper: "1"/"true"/"yes"/"on" -> true, "0"/"false"/"no"/"off"/"" -> false
const envBool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v.trim()));
const envStr = (v) => (v === undefined || String(v).trim() === '' ? undefined : String(v).trim());

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DROPPY_DATA_DIR || path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Turn Authentik on with a flip of a switch (persisted), or via env for first boot.
const AUTHENTIK_BASE_URL = envStr(process.env.AUTHENTIK_BASE_URL); // e.g. https://authentik.example.com (or http://host:9000)
const AUTHENTIK_SLUG = envStr(process.env.AUTHENTIK_SLUG) || 'droppy';
const AUTHENTIK_CLIENT_ID = envStr(process.env.AUTHENTIK_CLIENT_ID);
const AUTHENTIK_CLIENT_SECRET = envStr(process.env.AUTHENTIK_CLIENT_SECRET) || '';
const AUTHENTIK_SCOPES = envStr(process.env.AUTHENTIK_SCOPES) || 'openid profile email';
// Canonical public origin (e.g. https://droppy.innotel.us). When set it overrides the
// per-request Host for QR/LAN URLs, OIDC redirect URIs and blueprint generation.
const PUBLIC_URL = envStr(process.env.PUBLIC_URL) ? envStr(process.env.PUBLIC_URL).replace(/\/+$/, '') : null;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 h
const COOKIE_NAME = 'droppy_sid';

/* ----------------------------------------------------------------- state */

const state = {
  authEnabled: envBool(process.env.AUTH_ENABLED, false), // kill-switch (persisted)
  adminPasswordHash: envStr(process.env.ADMIN_PASSWORD) ? sha256(envStr(process.env.ADMIN_PASSWORD)) : null,
  sessionTtlMs: SESSION_TTL_MS,
  oidc: AUTHENTIK_BASE_URL && AUTHENTIK_CLIENT_ID
    ? {
        baseUrl: AUTHENTIK_BASE_URL.replace(/\/+$/, ''),
        slug: AUTHENTIK_SLUG,
        clientId: AUTHENTIK_CLIENT_ID,
        clientSecret: AUTHENTIK_CLIENT_SECRET,
        scopes: AUTHENTIK_SCOPES,
      }
    : null,
};

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (typeof s.authEnabled === 'boolean') state.authEnabled = s.authEnabled;
    if (typeof s.adminPasswordHash === 'string' && !state.adminPasswordHash) state.adminPasswordHash = s.adminPasswordHash;
    if (state.oidc && typeof s.oidc === 'object') Object.assign(state.oidc, s.oidc);
  } catch {}
}
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const { authEnabled, adminPasswordHash, oidc } = state;
    fs.writeFileSync(STATE_PATH, JSON.stringify({ authEnabled, adminPasswordHash, oidc }, null, 2));
    return true;
  } catch (e) {
    console.error('[droppy] failed to persist state:', e.message);
    return false;
  }
}

// Optional operator config (e.g. set/rotate admin password out-of-band).
// { "adminPasswordHash": "<sha256 hex>" }
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (typeof c.adminPasswordHash === 'string' && c.adminPasswordHash) {
      state.adminPasswordHash = c.adminPasswordHash;
    }
  } catch {}
}

loadConfig();
loadState();

/* --------------------------------------------------------------- helpers */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

const sessions = new Map(); // sid -> { email, name, exp }

function createSession(userinfo) {
  const sid = randomId(32);
  sessions.set(sid, { email: userinfo.email || userinfo.preferred_username || 'user', name: userinfo.name || userinfo.given_name || userinfo.email || 'user', exp: Date.now() + SESSION_TTL_MS });
  return sid;
}

function getSession(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.set(sid, undefined); // avoid unbounded map growth
    sessions.delete(sid);
    return null;
  }
  return s;
}

function destroySession(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
}

function send(res, code, body, headers = {}) {
  const h = { 'X-Content-Type-Options': 'nosniff', ...headers };
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (!h['Content-Type']) h['Content-Type'] = 'text/plain; charset=utf-8';
    h['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(code, h);
    res.end(body);
  } else {
    const json = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Content-Length'] = Buffer.byteLength(json);
    res.writeHead(code, h);
    res.end(json);
  }
}

function redirect(res, location, extraHeaders = {}) {
  send(res, 302, '', { Location: location, ...extraHeaders });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel === 'admin' || rel === 'admin/') rel = 'admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA-ish: unknown non-asset paths get index.html
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
          if (e2) return send(res, 404, 'Not found');
          send(res, 200, b2, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        });
      }
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lanAddresses(port) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push({ name, address: it.address, url: `http://${it.address}:${port}` });
    }
  }
  return out;
}

/* ---------------------------------------------------------- OIDC (PKCE) */

const oidcAuthRequests = new Map(); // state -> { verifier, next, exp }

function oidcUrls(base, slug) {
  return {
    auth: `${base}/application/o/${encodeURIComponent(slug)}/authorize`,
    token: `${base}/application/o/${encodeURIComponent(slug)}/token`,
    userinfo: `${base}/application/o/${encodeURIComponent(slug)}/userinfo`,
    logout: `${base}/application/o/${encodeURIComponent(slug)}/end-session`,
  };
}

async function oidcToken(tokenUrl, body) {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`token endpoint ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

/* ------------------------------------------------- authentik blueprint */

// Generates an authentik blueprint that creates the OAuth2 provider (public/PKCE client)
// and application for droppy in one shot. Structure mirrors authentik's own blueprints
// (blueprints/testing/oidc-conformance.yaml): !Find flow lookups, !KeyOf app→provider link,
// object-form redirect_uris (authentik 2024.2+).
function blueprintYaml({ slug, clientId, redirectUri }) {
  return `# Authentik blueprint for droppy — creates the provider + application in one click.
#
# Apply it either way:
#   * mount into the authentik container as /blueprints/droppy.yaml (auto-applied), or
#   * paste the YAML under Customize → Blueprints → Create.
#
# Then configure droppy:
#   AUTHENTIK_BASE_URL=<your authentik URL>
#   AUTHENTIK_CLIENT_ID=${clientId}
#   PUBLIC_URL=${redirectUri.replace('/api/auth/callback', '')}
version: 1
metadata:
  name: droppy
entries:
  - identifiers:
      slug: ${slug}
    model: authentik_providers_oauth2.oauth2provider
    id: droppy-provider
    attrs:
      name: droppy
      authorization_flow: !Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]
      invalidation_flow: !Find [authentik_flows.flow, [slug, default-provider-invalidation-flow]]
      client_type: public
      client_id: ${clientId}
      redirect_uris:
        - matching_mode: strict
          url: ${redirectUri}
          redirect_uri_type: authorization
      property_mappings:
        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-openid]]
        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-email]]
        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-profile]]
  - identifiers:
      slug: ${slug}
    model: authentik_core.application
    id: droppy-application
    attrs:
      name: droppy
      slug: ${slug}
      provider: !KeyOf droppy-provider
`;
}

/* ------------------------------------------------------------ admin auth */

function requireAdmin(req, res) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    send(res, 401, { error: 'admin token required' }, { 'WWW-Authenticate': 'Bearer realm="droppy-admin"' });
    return null;
  }
  if (!state.adminPasswordHash) {
    send(res, 409, { error: 'no admin password configured (set ADMIN_PASSWORD env or data/config.json)' });
    return null;
  }
  if (!timingSafeEqualStr(sha256(m[1]), state.adminPasswordHash)) {
    send(res, 403, { error: 'invalid admin password' });
    return null;
  }
  return true;
}

/* ------------------------------------------------------------ HTTP router */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    /* ---- health & config ---- */
    if (p === '/healthz') return send(res, 200, { ok: true });

    if (p === '/api/config') {
      const sess = getSession(req);
      return send(res, 200, {
        authEnabled: state.authEnabled,
        oidcConfigured: !!state.oidc,
        authenticated: !!sess,
        user: sess ? { email: sess.email, name: sess.name } : null,
      });
    }

    /* ---- OIDC flow ---- */
    if (p === '/api/auth/start' && req.method === 'GET') {
      if (!state.oidc) return send(res, 400, { error: 'Authentik is not configured' });
      const u = oidcUrls(state.oidc.baseUrl, state.oidc.slug);
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const st = randomId(24);
      oidcAuthRequests.set(st, { verifier, next: url.searchParams.get('next') || '/', exp: Date.now() + 10 * 60 * 1000 });
      if (oidcAuthRequests.size > 200) {
        for (const [k, v] of oidcAuthRequests) if (v.exp < Date.now()) oidcAuthRequests.delete(k);
      }
      // PUBLIC_URL (when set) wins over the request Host so the redirect matches the
      // origin whitelisted on the Authentik provider, even behind different proxies.
      const redirectUri = `${PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`}/api/auth/callback`;
      const authUrl = new URL(u.auth);
      authUrl.searchParams.set('client_id', state.oidc.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', state.oidc.scopes);
      authUrl.searchParams.set('state', st);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      return redirect(res, authUrl.toString());
      // redirect_uri must also be whitelisted on the Authentik provider
    }

    if (p === '/api/auth/callback' && req.method === 'GET') {
      if (!state.oidc) return send(res, 400, 'Authentik is not configured');
      const code = url.searchParams.get('code');
      const st = url.searchParams.get('state');
      const entry = st && oidcAuthRequests.get(st);
      if (!code || !entry) return send(res, 400, 'Missing code/state');
      oidcAuthRequests.delete(st);
      if (entry.exp < Date.now()) return send(res, 400, 'Login expired, try again');
      const u = oidcUrls(state.oidc.baseUrl, state.oidc.slug);
      const body = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`}/api/auth/callback`,
        client_id: state.oidc.clientId,
        code_verifier: entry.verifier,
      };
      if (state.oidc.clientSecret) body.client_secret = state.oidc.clientSecret;
      const tokens = await oidcToken(u.token, body);
      const uiRes = await fetch(u.userinfo, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (!uiRes.ok) return send(res, 502, 'Userinfo failed');
      const userinfo = await uiRes.json();
      const sid = createSession(userinfo);
      const next = entry.next.startsWith('/') ? entry.next : '/';
      return redirect(res, next, {
        'Set-Cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      destroySession(req);
      return send(res, 200, { ok: true });
    }

    /* ---- admin API (Bearer password) ---- */
    if (p === '/api/admin/login' && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      let pw = '';
      try { pw = String(JSON.parse(body.toString('utf8')).password || ''); } catch {}
      if (!state.adminPasswordHash) return send(res, 409, { error: 'No admin password configured. Restart with ADMIN_PASSWORD env set, or put adminPasswordHash in droppy/data/config.json.' });
      if (!pw || !timingSafeEqualStr(sha256(pw), state.adminPasswordHash)) {
        return send(res, 403, { error: 'Wrong admin password' });
      }
      return send(res, 200, { token: pw });
    }

    if (p === '/api/admin/state' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, {
        authEnabled: state.authEnabled,
        oidc: state.oidc
          ? { baseUrl: state.oidc.baseUrl, slug: state.oidc.slug, clientId: state.oidc.clientId, hasSecret: !!state.oidc.clientSecret }
          : null,
      });
    }

    if (p === '/api/admin/auth-toggle' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req, 64 * 1024);
      let enabled;
      try { enabled = !!JSON.parse(body.toString('utf8')).authEnabled; } catch { enabled = false; }
      if (enabled && !state.oidc) {
        return send(res, 409, { error: 'Authentik is not configured — set AUTHENTIK_BASE_URL and AUTHENTIK_CLIENT_ID first (enabling auth now would lock everyone out).' });
      }
      state.authEnabled = enabled;
      if (!saveState()) {
        // e.g. unwritable data dir: revert in memory and tell the operator,
        // otherwise the kill-switch looks flipped but silently resets on restart
        state.authEnabled = !enabled;
        return send(res, 500, { error: `Could not persist state (check that the data dir is writable by uid ${process.getuid ? process.getuid() : '?'}). Change not applied.` });
      }
      if (!enabled) {
        // kill-switch flipped off: end every existing session immediately
        sessions.clear();
      }
      return send(res, 200, { authEnabled: state.authEnabled });
    }

    /* ---- LAN info + QR ---- */
    if (p === '/api/lan' && req.method === 'GET') {
      const proto = String(req.headers['x-forwarded-proto'] || 'http');
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`);
      const selfUrl = PUBLIC_URL || `${proto}://${host}`;
      const addrs = PUBLIC_URL ? [{ name: 'public', address: PUBLIC_URL, url: PUBLIC_URL }] : lanAddresses(PORT);
      const qrData = addrs.length ? addrs[0].url : selfUrl;
      const qr = await QRCode.toDataURL(qrData, { margin: 1, width: 360, color: { dark: '#0b0d10', light: '#ffffff' } });
      return send(res, 200, { selfUrl, addresses: addrs, qr, port: PORT });
    }

    if (p === '/api/authentik/blueprint' && req.method === 'GET') {
      if (!PUBLIC_URL) {
        return send(res, 400, { error: 'PUBLIC_URL is not set — it defines the redirect URI origin (e.g. PUBLIC_URL=https://droppy.innotel.us)' });
      }
      const slug = (state.oidc && state.oidc.slug) || AUTHENTIK_SLUG || 'droppy';
      const clientId = (state.oidc && state.oidc.clientId) || AUTHENTIK_CLIENT_ID || 'droppy';
      const yaml = blueprintYaml({ slug, clientId, redirectUri: `${PUBLIC_URL}/api/auth/callback` });
      return send(res, 200, yaml, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="droppy-authentik.yaml"' });
    }

    /* ---- static ---- */
    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[droppy] request error:', err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  }
});

/* ------------------------------------------------------- gate + websocket */

function requestIsAuthenticated(req) {
  return !!getSession(req);
}

const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // room -> Set<ws>

function joinRoom(ws, room) {
  let set = rooms.get(room);
  if (!set) rooms.set(room, (set = new Set()));
  set.add(ws);
  ws.droppyRoom = room;
}

function leaveRoom(ws) {
  const room = ws.droppyRoom;
  if (!room) return;
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    if (!set.size) rooms.delete(room);
  }
  ws.droppyRoom = undefined;
}

function roomPeers(room, except) {
  const set = rooms.get(room);
  return set ? [...set].filter((c) => c !== except && c.readyState === 1) : [];
}

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary file chunk: [uint32 transferId][uint32 chunkIndex][payload]
      // transferId == sender's connId; fan out to every other peer in the room.
      if (!ws.droppyRoom || data.length <= 8) return;
      for (const peer of roomPeers(ws.droppyRoom, ws)) {
        if (peer.readyState === 1) peer.send(data, { binary: true });
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'join': {
        const room = String(msg.room || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
        if (!room) return wsSend(ws, { type: 'error', error: 'invalid room' });
        leaveRoom(ws);
        joinRoom(ws, room);
        ws.droppyConnIds = new Set();
        const peers = roomPeers(room, ws);
        wsSend(ws, { type: 'joined', room, peers: peers.length, yourId: nextConnId(ws) });
        for (const peer of peers) wsSend(peer, { type: 'peer-joined', count: roomPeers(room).length + 1 });
        break;
      }
      case 'hello': {
        if (!ws.droppyRoom) break;
        ws.droppyName = String(msg.name || 'device').slice(0, 40);
        const peers = roomPeers(ws.droppyRoom, ws);
        for (const peer of peers) {
          wsSend(ws, { type: 'peer-info', id: nextConnId(peer), name: peer.droppyName || 'device' });
          wsSend(peer, { type: 'peer-info', id: nextConnId(ws), name: ws.droppyName });
        }
        break;
      }
      case 'offer':
      case 'answer':
      case 'ice':
      case 'ring':
      case 'ringing':
      case 'accept':
      case 'decline': {
        // targeted signaling relay (WebRTC handshake + incoming-transfer notifications)
        if (!ws.droppyRoom) break;
        const id = Number(msg.to);
        const peer = roomPeers(ws.droppyRoom, ws).find((c) => c.droppyConnId === id);
        if (peer) {
          wsSend(peer, { type: msg.type, from: nextConnId(ws), payload: msg.payload });
        }
        break;
      }      case 'file-meta': {
        if (!ws.droppyRoom) break;
        const meta = {
          type: 'file-meta',
          from: nextConnId(ws),
          tid: Number(msg.tid) || 1,
          index: Number(msg.index) || 0,
          path: String(msg.path || msg.name || 'file').slice(0, 400),
          name: String(msg.name || 'file').slice(0, 255),
          size: Number(msg.size) || 0,
          mime: String(msg.mime || 'application/octet-stream').slice(0, 120),
          count: Math.max(1, Math.min(1000, Number(msg.count) || 1)),
        };
        for (const peer of roomPeers(ws.droppyRoom, ws)) wsSend(peer, meta);
        break;
      }
      case 'file-done': {
        if (!ws.droppyRoom) break;
        const done = { type: 'file-done', from: nextConnId(ws) };
        if (Number.isFinite(Number(msg.tid))) done.tid = Number(msg.tid);
        for (const peer of roomPeers(ws.droppyRoom, ws)) wsSend(peer, done);
        break;
      }
      case 'text': {
        if (!ws.droppyRoom) break;
        const t = String(msg.text || '').slice(0, 100_000);
        for (const peer of roomPeers(ws.droppyRoom, ws)) wsSend(peer, { type: 'text', text: t, from: nextConnId(ws) });
        break;
      }
      case 'leave': {
        leaveRoom(ws);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = ws.droppyRoom;
    leaveRoom(ws);
    if (room) {
      const remaining = roomPeers(room);
      for (const peer of remaining) wsSend(peer, { type: 'peer-left', count: remaining.length });
    }
  });
  ws.on('error', () => leaveRoom(ws));
});

let connCounter = 1;
function nextConnId(ws) {
  if (!ws.droppyConnId) ws.droppyConnId = connCounter++;
  return ws.droppyConnId;
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (state.authEnabled && !requestIsAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : HOST;
  console.log(`droppy  ▸  http://localhost:${PORT}`);
  console.log(`         ▸  listening on ${shown}`);
  const addrs = lanAddresses(PORT);
  if (addrs.length) console.log(`         ▸  LAN: ${addrs.map((a) => a.url).join('  ')}`);
  console.log(`         ▸  authentik SSO: ${state.oidc ? 'configured' : 'not configured'} | auth switch: ${state.authEnabled ? 'ON' : 'off'}`);
  if (!state.adminPasswordHash) {
    console.log('         ▸  tip: set ADMIN_PASSWORD env (or droppy/data/config.json adminPasswordHash) to manage the auth switch remotely');
  }
});

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));

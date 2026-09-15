'use strict';

/**
 * Cerulean Vault (SecretOps) client for zapit — the Innotel Platform Stack's
 * single source of truth for secrets (docs/stack.md).
 *
 * `.env` values may be plain text or `vault://<mount>/<path>#<key>` references —
 * the same grammar Cerulean, Onyx, Zeus, Atlas and Distro resolve. A reference
 * is resolved at startup: synchronously where the value must be hashed before
 * the server boots (see `resolveRefSync`), asynchronously otherwise.
 *
 * Read-only by design. Cerulean mints this stack's token with a policy covering
 * `<prefix>/data/zapit` and its metadata for **read/list** only, so nothing here
 * writes: pushing plain values *into* the store is `scripts/vault-migrate.py`,
 * run by an operator with a token that may write.
 *
 * Environment contract:
 *   VAULT_ADDR           base URL, e.g. http://10.10.1.1:8200
 *   VAULT_TOKEN          this stack's path-scoped token, or
 *   VAULT_TOKEN_FILE     a file holding it (the Vault CLI's own order)
 *   VAULT_NAMESPACE      Enterprise namespaces; unused on OSS Vault
 *   VAULT_SKIP_VERIFY    "1" to accept a self-signed certificate
 *   VAULT_CACERT         CA bundle for TLS
 */

const { execFileSync } = require('child_process');
const http = require('http');
const https = require('https');
const { readFileSync } = require('fs');

const REF_PREFIX = 'vault://';
const LEGACY_REF_PREFIX = 'infisical://';
const DEFAULT_STORE = 'cerulean';
const TIMEOUT_MS = 15_000;

/** Parse `vault://<mount>/<path>#<key>`; returns the parts or null.
 *
 * The `#key` fragment is required: a reference without one names a whole
 * secret, and a consumer that needs one value cannot guess which.
 */
function parseReference(value) {
  if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) return null;
  const rest = value.slice(REF_PREFIX.length);
  const hash = rest.indexOf('#');
  if (hash === -1) return null;
  const location = rest.slice(0, hash);
  const key = rest.slice(hash + 1).trim();
  const slash = location.indexOf('/');
  if (slash === -1) return null;
  const mount = location.slice(0, slash).trim();
  const path = location.slice(slash + 1).replace(/^\/+|\/+$/g, '').trim();
  if (!mount || !path || !key) return null;
  return { mount, path, key };
}

/** `<mount>/<path>#<key>` for messages, or null when not a reference. */
function refName(value) {
  const parsed = parseReference(value);
  return parsed ? `${parsed.mount}/${parsed.path}#${parsed.key}` : null;
}

/** True for a value still carrying the retired `infisical://` scheme. */
function isLegacyReference(value) {
  return typeof value === 'string' && value.startsWith(LEGACY_REF_PREFIX);
}

/** Build the runtime config from the environment. Never logs the token. */
function configFromEnv(env = process.env) {
  const cfg = {
    addr: (env.VAULT_ADDR || '').replace(/\/+$/, ''),
    token: readToken(env),
    namespace: env.VAULT_NAMESPACE || '',
    skipVerify: env.VAULT_SKIP_VERIFY === '1',
    cacert: env.VAULT_CACERT || '',
    store: env.VAULT_PREFIX || DEFAULT_STORE,
  };
  cfg.enabled = Boolean(cfg.addr && cfg.token);
  return cfg;
}

/** VAULT_TOKEN, else the contents of VAULT_TOKEN_FILE — the Vault CLI's order. */
function readToken(env) {
  const direct = (env.VAULT_TOKEN || '').trim();
  if (direct) return direct;
  const file = (env.VAULT_TOKEN_FILE || '').trim();
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    // An unreadable token file leaves the store unconfigured rather than
    // handing back an empty credential.
    return '';
  }
}

/** Explain why a reference cannot be resolved. Shared by both paths. */
function unconfiguredError(value) {
  return new Error(
    `value "${value}" references Cerulean Vault but VAULT_ADDR / VAULT_TOKEN ` +
      '(or VAULT_TOKEN_FILE) are not configured',
  );
}

/** Explain a reference that is malformed rather than merely unset. */
function malformedError(value) {
  return new Error(`"${value}" is not a vault://<mount>/<path>#<key> reference`);
}

/**
 * GET a Vault path and resolve the body. Rejects only on transport failure —
 * an HTTP status is the caller's to interpret.
 */
function vaultGet(cfg, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.addr}${pathname}`);
    const secure = url.protocol === 'https:';
    const headers = { 'X-Vault-Token': cfg.token, Accept: 'application/json' };
    if (cfg.namespace) headers['X-Vault-Namespace'] = cfg.namespace;

    const options = { method: 'GET', headers, timeout: TIMEOUT_MS };
    if (secure) {
      if (cfg.skipVerify) options.rejectUnauthorized = false;
      else if (cfg.cacert) options.ca = readFileSync(cfg.cacert);
    }

    const req = (secure ? https : http).request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { errors: text.slice(0, 200) };
        }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Read one KV v2 secret: GET <mount>/data/<path> → data.data. */
async function readSecret(cfg, mount, path) {
  const id = `${mount}/${path}`;
  const { status, body } = await vaultGet(cfg, `/v1/${mount}/data/${path}`);
  if (status === 404) {
    throw new Error(
      `vault: ${id} is not in ${cfg.addr} — seed this stack's secrets with ` +
        '`python3 scripts/vault-migrate.py --from-env-file .env`',
    );
  }
  if (status !== 200) {
    const detail = body && body.errors ? JSON.stringify(body.errors).slice(0, 200) : '';
    throw new Error(`vault: reading ${id} failed (HTTP ${status}) ${detail}`.trim());
  }
  const outer = body && body.data;
  if (!outer || typeof outer !== 'object' || !outer.data || typeof outer.data !== 'object') {
    throw new Error(
      `vault: ${mount}/ is not answering as KV v2 (the read returned no data.data nesting) — ` +
        `point VAULT_PREFIX at the KV v2 mount (Cerulean's default is \`${DEFAULT_STORE}\`)`,
    );
  }
  return outer.data;
}

/** Resolve one `vault://` reference to its value. Plain values pass through. */
async function resolveEnvValue(cfg, value) {
  if (!parseReference(value)) {
    if (isLegacyReference(value)) throw legacyError(value);
    return value;
  }
  if (!cfg.enabled) throw unconfiguredError(value);
  return readRef(cfg, value);
}

/** Infisical is retired here, not a fallback: say what to do instead. */
function legacyError(value) {
  return new Error(
    `value "${value}" still uses infisical:// — Infisical is retired. ` +
      'Move those secrets with scripts/vault-migrate.py and use vault://<mount>/<path>#<key>.',
  );
}

/**
 * Synchronous boot-time resolution for values that must exist before the server
 * starts (ADMIN_PASSWORD is hashed there). The read happens in a child node
 * process, because a blocking read cannot be done in-process without stalling
 * the event loop this very call runs on. Plain values pass through unchanged.
 */
function resolveRefSync(cfg, value) {
  const parsed = parseReference(value);
  if (!parsed) {
    if (isLegacyReference(value)) throw legacyError(value);
    return value;
  }
  if (!cfg.enabled) throw unconfiguredError(value);

  // The child requires this same module, so the read path — KV v2 nesting, TLS
  // options, the empty-credential refusal — is shared rather than reimplemented.
  const script = `
    const vault = require(process.argv[1]);
    const cfg = JSON.parse(process.argv[2]);
    vault
      .readRef(cfg, process.argv[3])
      .then((v) => process.stdout.write(v))
      .catch((e) => { console.error(e.message); process.exit(1); });
  `;
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', script, __filename, JSON.stringify(cfg), value], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').pop();
    throw new Error(`vault resolve ${refName(value) || value} failed: ${detail}`);
  }
  return out.trim();
}

/**
 * Resolve one reference: read its path, take its key, refuse an empty value.
 * The single place a reference becomes a value — `resolveEnvValue` and the
 * boot-time child process both come through here.
 */
async function readRef(cfg, value) {
  const parsed = parseReference(value);
  if (!parsed) throw malformedError(value);

  const secret = await readSecret(cfg, parsed.mount, parsed.path);
  const resolved = secret[parsed.key];
  if (resolved === undefined) {
    throw new Error(
      `vault: ${parsed.mount}/${parsed.path} has no key ${parsed.key} ` +
        `(present: ${Object.keys(secret).sort().join(', ')})`,
    );
  }
  if (typeof resolved !== 'string' || !resolved) {
    throw new Error(`vault: ${refName(value)} is empty — refusing to hand back an empty credential`);
  }
  return resolved;
}

module.exports = {
  parseReference,
  refName,
  isLegacyReference,
  configFromEnv,
  readSecret,
  readRef,
  resolveEnvValue,
  resolveRefSync,
};

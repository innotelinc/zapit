'use strict';

/**
 * Infisical (SecretOps) client for zapit — the Innotel Platform Stack's
 * single source of truth for secrets (docs/stack.md).
 *
 * Mirrors the Cerulean/Onyx integration contract: .env values may be plain
 * text or `infisical://<name>` references. A reference is resolved at
 * startup; plain values can be mirrored into Infisical so .env can switch to
 * references after the first boot.
 *
 * Environment contract (written back to .env by scripts/infisical-setup.py):
 *   INFISICAL_ADDR           base URL, default http://localhost:8383
 *   INFISICAL_TOKEN          scoped service token
 *   INFISICAL_WORKSPACE_ID   workspace (project) the token is scoped to
 *   INFISICAL_ENVIRONMENT    environment folder, default "prod"
 */

const { execFileSync } = require('child_process');
const { URL } = require('url');

const REF_PREFIX = 'infisical://';

/** Parse `infisical://<name>`; returns the name or null. */
function refName(value) {
  if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) return null;
  const name = value.slice(REF_PREFIX.length).trim();
  return name || null;
}

/** Build the runtime config from the environment. */
function configFromEnv(env = process.env) {
  const cfg = {
    addr: (env.INFISICAL_ADDR || '').replace(/\/+$/, ''),
    token: env.INFISICAL_TOKEN || '',
    workspaceId: env.INFISICAL_WORKSPACE_ID || '',
    environment: env.INFISICAL_ENVIRONMENT || 'prod',
  };
  cfg.enabled = Boolean(cfg.addr && cfg.token && cfg.workspaceId);
  return cfg;
}

/** Resolve one env value against the API: refs are read, plain values pass. */
async function resolveEnvValue(cfg, value) {
  const name = refName(value);
  if (!name) return value;
  if (!cfg.enabled) {
    throw new Error(
      `value "${value}" references Infisical but INFISICAL_ADDR/TOKEN/WORKSPACE_ID are not configured`,
    );
  }
  return readSecret(cfg, name);
}

/** GET /api/v3/secrets/raw/{name} — returns the secret value. */
async function readSecret(cfg, name) {
  const u = new URL(`${cfg.addr}/api/v3/secrets/raw/${encodeURIComponent(name)}`);
  u.searchParams.set('workspaceId', cfg.workspaceId);
  u.searchParams.set('environment', cfg.environment);
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`infisical read ${name} failed (HTTP ${res.status})`);
  }
  const body = await res.json();
  const value = body && body.secret && body.secret.secretValue;
  if (value === undefined) throw new Error(`infisical secret not found: ${name}`);
  return value;
}

/** POST /api/v3/secrets/raw/{name} — upsert a secret value. */
async function writeSecret(cfg, name, value) {
  if (!cfg.enabled) {
    throw new Error('infisical not configured (INFISICAL_ADDR/TOKEN/WORKSPACE_ID)');
  }
  const u = `${cfg.addr}/api/v3/secrets/raw/${encodeURIComponent(name)}`;
  const res = await fetch(u, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      workspaceId: cfg.workspaceId,
      environment: cfg.environment,
      secretPath: '/',
      type: 'shared',
      secretValue: value,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 201) {
    throw new Error(`infisical write ${name} failed (HTTP ${res.status})`);
  }
}

/**
 * Synchronous boot-time resolution: refs are resolved in a child node
 * process (boot-only, one-shot) so callers can hash/use the value before
 * the server starts. Plain values pass through unchanged.
 */
function resolveRefSync(cfg, value) {
  const name = refName(value);
  if (!name) return value;
  if (!cfg.enabled) {
    throw new Error(
      `value "${value}" references Infisical but INFISICAL_ADDR/TOKEN/WORKSPACE_ID are not configured`,
    );
  }
  const script = `
    (async () => {
      const [value, envJson] = [process.argv[1], process.argv[2]];
      const cfg = JSON.parse(envJson);
      const name = value.slice(${JSON.stringify(REF_PREFIX)}.length).trim();
      const u = new URL(cfg.addr + '/api/v3/secrets/raw/' + encodeURIComponent(name));
      u.searchParams.set('workspaceId', cfg.workspaceId);
      u.searchParams.set('environment', cfg.environment);
      const res = await fetch(u, {
        headers: { Authorization: 'Bearer ' + cfg.token },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { console.error('HTTP ' + res.status); process.exit(2); }
      const body = await res.json();
      const v = body && body.secret && body.secret.secretValue;
      if (v === undefined) { console.error('secret not found'); process.exit(3); }
      process.stdout.write(v);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', script, value, JSON.stringify(cfg)], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').pop();
    throw new Error(`infisical resolve ${name} failed: ${detail}`);
  }
  return out.trim();
}

/**
 * Best-effort mirror of plain env values into Infisical (fire-and-forget).
 * Refs and empty values are skipped; failures are logged, never thrown.
 */
async function mirror(cfg, entries) {
  const written = [];
  const errs = [];
  if (!cfg.enabled) return { written, errs };
  for (const [name, value] of Object.entries(entries)) {
    if (!value || refName(value)) continue;
    try {
      await writeSecret(cfg, name, value);
      written.push(name);
    } catch (err) {
      errs.push(err);
    }
  }
  return { written, errs };
}

module.exports = {
  refName,
  configFromEnv,
  resolveEnvValue,
  readSecret,
  writeSecret,
  resolveRefSync,
  mirror,
};
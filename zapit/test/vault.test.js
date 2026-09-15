'use strict';

/**
 * Unit tests for the Cerulean Vault (SecretOps) client — zapit/vault.js.
 * Pure node:test + a local HTTP mock; no external dependencies.
 *
 *   node --test test/vault.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const vault = require('../vault');

const REF = 'vault://cerulean/zapit#ADMIN_PASSWORD';

/** A KV v2 envelope, the shape a real Vault read returns. */
const kv2 = (data) => JSON.stringify({ data: { data, metadata: { version: 1 } } });

/**
 * Spin a mock Vault API serving one secret at cerulean/zapit.
 * Unknown keys 404 the same way a real missing secret does.
 */
function mockVault(secret = { ADMIN_PASSWORD: 'resolved-ADMIN_PASSWORD', AUTHENTIK_CLIENT_SECRET: 'sso' }) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-vault-token'] });
    if (!/^\/v1\/cerulean\/data\/zapit(\?|$)/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: ['not found'] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(kv2(secret));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        seen,
        close: () => srv.close(),
      });
    });
  });
}

const cfgOf = (addr) => ({
  addr,
  token: 'tok',
  namespace: '',
  skipVerify: false,
  cacert: '',
  store: 'cerulean',
  enabled: true,
});

test('parseReference: vault://<mount>/<path>#<key>', () => {
  assert.deepEqual(vault.parseReference(REF), {
    mount: 'cerulean',
    path: 'zapit',
    key: 'ADMIN_PASSWORD',
  });
  assert.deepEqual(vault.parseReference('vault://cerulean/zapit/app#TOKEN'), {
    mount: 'cerulean',
    path: 'zapit/app',
    key: 'TOKEN',
  });
  // The #key fragment, the mount and the path are all required.
  assert.equal(vault.parseReference('vault://cerulean/zapit'), null);
  assert.equal(vault.parseReference('vault://zapit#K'), null);
  assert.equal(vault.parseReference('vault://cerulean/#K'), null);
  assert.equal(vault.parseReference('vault://cerulean/zapit#'), null);
  assert.equal(vault.parseReference('plain-value'), null);
  assert.equal(vault.parseReference('infisical://ADMIN_PASSWORD'), null);
  assert.equal(vault.parseReference(undefined), null);
  assert.equal(vault.parseReference(''), null);
});

test('refName and isLegacyReference', () => {
  assert.equal(vault.refName(REF), 'cerulean/zapit#ADMIN_PASSWORD');
  assert.equal(vault.refName('plain'), null);
  assert.equal(vault.isLegacyReference('infisical://ADMIN_PASSWORD'), true);
  assert.equal(vault.isLegacyReference(REF), false);
  assert.equal(vault.isLegacyReference(undefined), false);
});

test('configFromEnv: enabled/disabled, token file, default store', () => {
  const enabled = vault.configFromEnv({
    VAULT_ADDR: 'http://127.0.0.1:8200/',
    VAULT_TOKEN: 't',
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.addr, 'http://127.0.0.1:8200');
  assert.equal(enabled.store, 'cerulean');

  const disabled = vault.configFromEnv({});
  assert.equal(disabled.enabled, false);
  // An address with no token is not a configured store.
  assert.equal(vault.configFromEnv({ VAULT_ADDR: 'http://v:8200' }).enabled, false);

  const fromFile = vault.configFromEnv({
    VAULT_ADDR: 'http://v:8200',
    VAULT_TOKEN_FILE: `${__dirname}/fixtures-does-not-exist.token`,
  });
  assert.equal(fromFile.enabled, false, 'an unreadable token file is not a credential');
});

test('readSecret: KV v2 nesting, the token header and the path', async () => {
  const mock = await mockVault();
  try {
    const secret = await vault.readSecret(cfgOf(mock.url), 'cerulean', 'zapit');
    assert.deepEqual(secret, { ADMIN_PASSWORD: 'resolved-ADMIN_PASSWORD', AUTHENTIK_CLIENT_SECRET: 'sso' });
    assert.equal(mock.seen[0].method, 'GET');
    assert.equal(mock.seen[0].url, '/v1/cerulean/data/zapit');
    assert.equal(mock.seen[0].token, 'tok');
  } finally {
    mock.close();
  }
});

test('readSecret: a missing path explains how to seed it', async () => {
  const mock = await mockVault();
  try {
    await assert.rejects(
      vault.readSecret(cfgOf(mock.url), 'cerulean', 'nope'),
      /cerulean\/nope is not in .*vault-migrate\.py/s,
    );
  } finally {
    mock.close();
  }
});

test('readSecret: a KV v1 mount is refused, not misread', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // KV v1 stops at data — the value would look like an empty secret.
    res.end(JSON.stringify({ data: { ADMIN_PASSWORD: 'flat' } }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      vault.readSecret(cfgOf(`http://127.0.0.1:${srv.address().port}`), 'cerulean', 'zapit'),
      /not answering as KV v2/,
    );
  } finally {
    srv.close();
  }
});

test('resolveEnvValue: passthrough, ref, and the two refusal paths', async () => {
  const mock = await mockVault();
  try {
    const cfg = cfgOf(mock.url);
    assert.equal(await vault.resolveEnvValue(cfg, 'plain'), 'plain');
    assert.equal(await vault.resolveEnvValue(cfg, REF), 'resolved-ADMIN_PASSWORD');
    assert.equal(await vault.resolveEnvValue(cfg, undefined), undefined);

    // A reference with no store configured cannot silently pass through.
    await assert.rejects(
      vault.resolveEnvValue({ ...cfg, enabled: false }, REF),
      /VAULT_ADDR \/ VAULT_TOKEN/,
    );
    // A retired scheme is named, not treated as a plain value.
    await assert.rejects(
      vault.resolveEnvValue(cfg, 'infisical://ADMIN_PASSWORD'),
      /Infisical is retired/,
    );
    // A key that is not in the secret lists what is.
    await assert.rejects(
      vault.resolveEnvValue(cfg, 'vault://cerulean/zapit#MISSING'),
      /has no key MISSING \(present: ADMIN_PASSWORD, AUTHENTIK_CLIENT_SECRET\)/,
    );
  } finally {
    mock.close();
  }
});

test('resolveEnvValue: an empty value is refused', async () => {
  const mock = await mockVault({ ADMIN_PASSWORD: '' });
  try {
    await assert.rejects(
      vault.resolveEnvValue(cfgOf(mock.url), REF),
      /is empty — refusing to hand back an empty credential/,
    );
  } finally {
    mock.close();
  }
});

test('resolveRefSync: sync child-process resolution (boot path)', async () => {
  // The mock must live in a SEPARATE process: resolveRefSync uses
  // execFileSync, which blocks this process's event loop — an in-process
  // mock could never answer the child's request (deadlock).
  const { spawn } = require('node:child_process');
  const mockCode = `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (!/^\\/v1\\/cerulean\\/data\\/zapit(\\?|$)/.test(req.url)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: ['not found'] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { data: { ADMIN_PASSWORD: 'resolved-ADMIN_PASSWORD' } } }));
    });
    srv.listen(0, '127.0.0.1', () => console.log('READY ' + srv.address().port));
  `;
  const mock = spawn(process.execPath, ['-e', mockCode], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    mock.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/READY (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    mock.on('exit', (code) => reject(new Error('mock exited early: ' + code)));
    setTimeout(() => reject(new Error('mock never became ready')), 5000);
  });

  try {
    const cfg = cfgOf(`http://127.0.0.1:${port}`);
    // passthrough
    assert.equal(vault.resolveRefSync(cfg, 'plain'), 'plain');
    assert.equal(vault.resolveRefSync(cfg, undefined), undefined);
    // resolved ref
    assert.equal(vault.resolveRefSync(cfg, REF), 'resolved-ADMIN_PASSWORD');
    // missing secret → throws
    assert.throws(() => vault.resolveRefSync(cfg, 'vault://cerulean/zapit#MISSING'), /failed/);
    // unconfigured → throws
    assert.throws(() => vault.resolveRefSync({ ...cfg, enabled: false }, REF), /VAULT_ADDR/);
    // retired scheme → throws
    assert.throws(
      () => vault.resolveRefSync(cfg, 'infisical://ADMIN_PASSWORD'),
      /Infisical is retired/,
    );
  } finally {
    mock.kill();
  }
});

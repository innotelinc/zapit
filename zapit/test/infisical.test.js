'use strict';

/**
 * Unit tests for the Infisical (SecretOps) client — zapit/infisical.js.
 * Pure node:test + a local HTTP mock; no external dependencies.
 *
 *   node --test test/infisical.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const infisical = require('../infisical');

/** Spin a mock Infisical API; returns { url, close }. */
function mockInfisical() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST') seen[seen.length - 1].body = JSON.parse(body || '{}');
      const name = decodeURIComponent((req.url.split('?')[0].split('/').pop() || ''));
      if (name === '__probe__' || name === 'MISSING') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
        return;
      }
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secret: { secretKey: name, secretValue: body } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: { secretKey: name, secretValue: 'resolved-' + name } }));
    });
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
  workspaceId: 'ws',
  environment: 'prod',
  enabled: true,
});

test('refName parsing', () => {
  assert.equal(infisical.refName('infisical://ADMIN_PASSWORD'), 'ADMIN_PASSWORD');
  assert.equal(infisical.refName('infisical://  spaced  '), 'spaced');
  assert.equal(infisical.refName('infisical://'), null);
  assert.equal(infisical.refName('plain-value'), null);
  assert.equal(infisical.refName(undefined), null);
  assert.equal(infisical.refName(''), null);
});

test('configFromEnv: enabled/disabled + default environment', () => {
  const enabled = infisical.configFromEnv({
    INFISICAL_ADDR: 'http://127.0.0.1:8383',
    INFISICAL_TOKEN: 't',
    INFISICAL_WORKSPACE_ID: 'w',
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.environment, 'prod');

  const disabled = infisical.configFromEnv({});
  assert.equal(disabled.enabled, false);
});

test('readSecret: GET shape + value', async () => {
  const mock = await mockInfisical();
  try {
    const value = await infisical.readSecret(cfgOf(mock.url), 'ADMIN_PASSWORD');
    assert.equal(value, 'resolved-ADMIN_PASSWORD');
    assert.equal(mock.seen[0].method, 'GET');
    assert.ok(mock.seen[0].url.includes('workspaceId=ws'));
    assert.ok(mock.seen[0].url.includes('environment=prod'));
    assert.equal(mock.seen[0].auth, 'Bearer tok');
  } finally {
    mock.close();
  }
});

test('readSecret: missing secret throws', async () => {
  const mock = await mockInfisical();
  try {
    await assert.rejects(infisical.readSecret(cfgOf(mock.url), 'MISSING'), /HTTP 404/);
  } finally {
    mock.close();
  }
});

test('writeSecret: POST payload', async () => {
  const mock = await mockInfisical();
  try {
    await infisical.writeSecret(cfgOf(mock.url), 'ADMIN_PASSWORD', 'hunter2');
    const call = mock.seen.find((s) => s.method === 'POST');
    assert.ok(call, 'expected a POST');
    assert.equal(call.body.secretValue, 'hunter2');
    assert.equal(call.body.type, 'shared');
    assert.equal(call.body.workspaceId, 'ws');
    assert.equal(call.body.environment, 'prod');
  } finally {
    mock.close();
  }
});

test('resolveEnvValue: passthrough + ref + unconfigured error', async () => {
  const mock = await mockInfisical();
  try {
    const cfg = cfgOf(mock.url);
    assert.equal(await infisical.resolveEnvValue(cfg, 'plain'), 'plain');
    assert.equal(
      await infisical.resolveEnvValue(cfg, 'infisical://ADMIN_PASSWORD'),
      'resolved-ADMIN_PASSWORD',
    );
  } finally {
    mock.close();
  }
  await assert.rejects(
    infisical.resolveEnvValue({ ...cfgOf(mock.url), enabled: false }, 'infisical://X'),
    /not configured/,
  );
});

test('mirror: writes plain values, skips refs, collects errors', async () => {
  const mock = await mockInfisical();
  try {
    const cfg = cfgOf(mock.url);
    const { written, errs } = await infisical.mirror(cfg, {
      ADMIN_PASSWORD: 'hunter2',          // plain → mirrored
      AUTHENTIK_CLIENT_SECRET: 'infisical://X', // ref → skipped
      EMPTY: '',                          // empty → skipped
    });
    assert.deepEqual(written, ['ADMIN_PASSWORD']);
    assert.deepEqual(errs, []);

    const { written: w2, errs: e2 } = await infisical.mirror(
      { ...cfgOf(''), enabled: false },
      { A: 'b' },
    );
    assert.deepEqual(w2, []);
    assert.deepEqual(e2, []);
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
      const name = decodeURIComponent(req.url.split('?')[0].split('/').pop() || '');
      if (name === 'MISSING') { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: { secretValue: 'resolved-' + name } }));
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
    assert.equal(infisical.resolveRefSync(cfg, 'plain'), 'plain');
    assert.equal(infisical.resolveRefSync(cfg, undefined), undefined);
    // resolved ref
    assert.equal(
      infisical.resolveRefSync(cfg, 'infisical://ADMIN_PASSWORD'),
      'resolved-ADMIN_PASSWORD',
    );
    // missing secret → throws
    assert.throws(() => infisical.resolveRefSync(cfg, 'infisical://MISSING'), /failed/);
    // unconfigured → throws
    assert.throws(() => infisical.resolveRefSync({ ...cfg, enabled: false }, 'infisical://X'), /not configured/);
  } finally {
    mock.kill();
  }
});
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../config.mjs';

test('local startup keeps loopback and existing port and timeout defaults', () => {
  assert.deepEqual(readConfig({}), { host: '127.0.0.1', port: 8089, pollMs: 1500, timeoutMs: 180000 });
});

test('container and IPv6 listen addresses can be explicitly configured', () => {
  assert.deepEqual(readConfig({ LINEAR_HOST: '0.0.0.0', LINEAR_PORT: '8090', LINEAR_POLL_MS: '500', LINEAR_TIMEOUT_MS: '1000' }), { host: '0.0.0.0', port: 8090, pollMs: 500, timeoutMs: 1000 });
  assert.equal(readConfig({ LINEAR_HOST: '::1' }).host, '::1');
});

test('invalid listen addresses, ports and timeout settings fail before startup', () => {
  for (const env of [{ LINEAR_HOST: 'https://example.com' }, { LINEAR_HOST: 'not-an-ip' }, { LINEAR_PORT: '0' }, { LINEAR_PORT: '65536' }, { LINEAR_PORT: '3.5' }, { LINEAR_POLL_MS: '499' }, { LINEAR_TIMEOUT_MS: '999' }]) {
    assert.throws(() => readConfig(env), /Invalid LINEAR_/);
  }
});

test('fresh server boots without credentials and preserves its key and routing policy on restart', { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-startup-test-'));
  let child;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  t.after(async () => {
    await stop();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-startup-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) await fs.copyFile(path.join(source, entry.name), path.join(directory, entry.name));
  }
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  async function start() {
    child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(directory, 'server.mjs')], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LINEAR_HOST: '127.0.0.1', LINEAR_PORT: String(port), LINEAR_POLL_MS: '500', LINEAR_TIMEOUT_MS: '1000', LINEAR_SESSION_FILE: path.join(directory, 'absent-session.json') }
    });
    await new Promise((resolve, reject) => {
      let output = '', errorOutput = '';
      const timer = setTimeout(() => reject(new Error('Fresh server startup timed out.')), 10000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error('Fresh server exited with ' + code + ': ' + errorOutput)));
      child.stderr.on('data', chunk => { errorOutput += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('Linear Agent gateway:')) { clearTimeout(timer); resolve(); }
      });
    });
  }
  await start();
  assert.equal((await (await fetch(base + '/health')).json()).service, 'linear-agent-gateway');
  assert.equal((await fetch(base + '/v1/accounts')).status, 401);
  const accessFile = path.join(directory, '.local-runtime', 'access.json');
  const { api_key: key } = JSON.parse(await fs.readFile(accessFile, 'utf8'));
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  assert.equal((await (await fetch(base + '/v1/accounts', { headers })).json()).data.length, 0);
  const policy = { strategy: 'fixed', cooldown_seconds: 24 };
  assert.equal((await fetch(base + '/v1/routing', { method: 'POST', headers, body: JSON.stringify(policy) })).status, 200);
  await stop();
  await start();
  assert.equal(JSON.parse(await fs.readFile(accessFile, 'utf8')).api_key, key);
  const persisted = await (await fetch(base + '/v1/routing', { headers })).json();
  assert.equal(persisted.policy.strategy, policy.strategy);
  assert.equal(persisted.policy.cooldown_seconds, policy.cooldown_seconds);
});

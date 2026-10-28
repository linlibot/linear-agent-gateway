import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Only run against the disposable, empty-account volume created by CI.
assert.equal(process.env.LINEAR_CONTAINER_TEST, '1', 'This test requires an explicitly disposable container.');
assert(process.getuid?.() > 0, 'The container must run without root.');
for (const path of ['../.local-runtime/build-canary.txt', '../outputs/build-canary.txt', '../.private/build-canary.txt', '../.env', '../credential-canary.har', '../.git']) {
  await assert.rejects(fs.access(new URL(path, import.meta.url)), { code: 'ENOENT' });
}
const runtime = new URL('../.local-runtime/', import.meta.url);
const { api_key: key } = JSON.parse(await fs.readFile(new URL('access.json', runtime), 'utf8'));
assert(key.length >= 32);
const base = 'http://127.0.0.1:' + (process.env.LINEAR_PORT || '8089');
async function api(path, body, token = key) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
}
assert.equal((await api('/v1/accounts', undefined, false)).status, 401);
assert.equal((await api('/v1/accounts')).status, 401, 'The initialization key must not bypass administrator login.');
assert.equal((await api('/v1')).status, 200);
assert.equal((await api('/accounts')).status, 303);
assert.equal((await api('/keys')).status, 303);
const restarting = process.argv.includes('--verify-restart');
const authState = await (await api('/auth/session', undefined, false)).json();
assert.equal(authState.configured, restarting);
assert.equal(authState.authenticated, false);
const username = 'disposable-ci-admin', password = 'Disposable CI administrator passphrase!';
const authenticated = await api(restarting ? '/auth/login' : '/auth/setup', { username, password, ...(restarting ? {} : { bootstrap_key: key }) }, false);
assert.equal(authenticated.status, 200);
const cookie = authenticated.headers.get('set-cookie').split(';')[0], profile = await authenticated.json();
assert.match(authenticated.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
async function manage(path, body, csrf = profile.csrf_token) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/json', ...(body === undefined ? {} : { 'x-csrf-token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
}
assert.equal((await manage('/keys')).status, 200);
assert.equal((await manage('/accounts')).status, 200);
assert.equal((await manage('/v1/routing', { max_attempts: 2 }, 'forged-csrf')).status, 403);
assert.equal((await manage('/v1/chat/completions', { model: 'linear-agent', messages: [{ role: 'user', content: '你好' }] })).status, 401, 'A password cookie must not authorize chat calls.');
const accounts = await (await manage('/v1/accounts')).json();
assert.equal(accounts.data.length, 0, 'Never run this test against saved user accounts.');
const adminStore = await fs.readFile(new URL('admin-auth.json', runtime), 'utf8');
for (const secret of [password, cookie.split('=')[1], profile.csrf_token]) assert(!adminStore.includes(secret));
const models = await (await api('/v1/models')).json();
assert.deepEqual(models.data.map(m => m.id), ['linear-agent']);
const digest = createHash('sha256').update(key).digest('hex');
const marker = new URL('container-smoke.json', runtime);
const clientToken = 'CI_ONLY_CALL_KEY_' + 'x'.repeat(48);
if (restarting) {
  const saved = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.equal(saved.key_digest, digest);
  const routing = await (await manage('/v1/routing')).json();
  assert.deepEqual(routing.policy, saved.policy);
  assert.equal((await api('/v1/models', undefined, clientToken)).status, 200);
  const client = (await (await manage('/v1/keys')).json()).data.find(k => k.id === saved.client_id);
  assert.equal(client.requests, 1); assert.equal(client.failures, 1); assert.equal(client.enabled, true);
  console.log('Container recreation preserved password login, the initialization key, client keys, call counters and routing policy.');
} else {
  const changed = await manage('/v1/routing', { max_attempts: 2, cooldown_seconds: 23 });
  assert.equal(changed.status, 200);
  const { policy } = await changed.json();
  assert.equal(policy.max_attempts, 2);
  assert.equal(policy.cooldown_seconds, 23);
  const created = await manage('/v1/keys', { name: 'Disposable container test', key: clientToken });
  assert.equal(created.status, 201);
  const client = await created.json();
  assert.equal(client.api_key, clientToken);
  assert.equal((await api('/v1/models', undefined, clientToken)).status, 200);
  assert.equal((await api('/v1/accounts', undefined, clientToken)).status, 403);
  assert.equal((await api('/v1/keys', undefined, clientToken)).status, 403);
  assert.equal((await api('/v1/chat/completions', { model: 'linear-agent', messages: [{ role: 'user', content: '你好' }] }, clientToken)).status, 503);
  const store = await fs.readFile(new URL('client-keys.json', runtime), 'utf8');
  assert(!store.includes(clientToken));
  await fs.writeFile(marker, JSON.stringify({ key_digest: digest, policy, client_id: client.data.id }), { mode: 0o600 });
  console.log('Container checks passed: non-root, clean image, password login, CSRF, client-key permissions, usage tracking and writable data volume.');
}
assert.equal((await manage('/auth/logout', {})).status, 200);
assert.equal((await manage('/v1/keys')).status, 401);
assert.equal((await manage('/keys')).status, 303);

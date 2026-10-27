import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClientKeyStore } from '../client-keys.mjs';
import { AccountStore } from '../accounts.mjs';
import { AccountRouter } from '../routing.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT, GatewayError } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';

const administrator = 'TEST_ADMIN_' + 'a'.repeat(40);
const custom = 'TEST_CLIENT_' + 'b'.repeat(40);
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-keys-test-'));
  const runtime = pathToFileURL(directory + path.sep);
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-keys-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const keys = new ClientKeyStore(runtime, { adminKey: administrator });
  await keys.initialize();
  const accounts = new AccountStore(runtime);
  await accounts.initialize();
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await accounts.import({ endpoint: ENDPOINT, headers: { user: 'user-' + i, organization: 'org-' + i, cookie: 'SYNTHETIC_COOKIE_' + i } })).account.id);
  const modelsProvider = async () => modelEntries();
  const router = new AccountRouter(accounts, { modelsProvider });
  await router.initialize();
  const calls = [], errors = [], before = new Map(), after = new Map();
  let hold;
  const server = createGateway({ apiKey: administrator, accountStore: accounts, accountRouter: router, clientKeys: keys, modelsProvider, timeoutMs: 10000, onError: e => errors.push(e), clientFactory: account => ({
    chat: async (input, signal, accepted) => {
      calls.push(account.id);
      if (before.has(account.id)) throw new GatewayError(503, before.get(account.id), 'Synthetic rejection.');
      const conversationId = input.conversationId ?? randomUUID();
      await accepted(conversationId);
      if (hold) await hold();
      if (after.has(account.id)) throw new GatewayError(502, after.get(account.id), 'Synthetic accepted failure.');
      return { text: 'OK', conversationId };
    }
  }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, token = administrator, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const chat = (token, body = {}) => request('/v1/chat/completions', token, { model: 'linear-agent', messages: [{ role: 'user', content: '你好' }], ...body });
  return { runtime, keys, accounts, router, ids, calls, errors, before, after, request, chat, setHold: value => { hold = value; } };
}

test('generated and custom client keys survive restart with only hashes stored and disable immediately', async t => {
  const f = await setup(t);
  const generated = await f.keys.create({ name: 'Cherry' });
  assert.match(generated.api_key, /^lgc-[a-f0-9]{64}$/);
  const own = await f.keys.create({ name: 'My key', key: custom });
  assert.equal(own.api_key, custom);
  const disk = await fs.readFile(f.keys.file, 'utf8');
  assert(!disk.includes(custom)); assert(!disk.includes(generated.api_key)); assert(!disk.includes(administrator));
  const listed = JSON.stringify(await f.keys.list());
  assert(!listed.includes('digest')); assert(!listed.includes('api_key')); assert(!listed.includes(custom));
  const restarted = new ClientKeyStore(f.runtime, { adminKey: administrator });
  await restarted.initialize();
  assert.equal((await restarted.authenticate(custom)).id, own.data.id);
  await restarted.setEnabled(own.data.id, false);
  assert.equal(await f.keys.authenticate(custom), null);
  await f.keys.setEnabled(own.data.id, true);
  assert.equal((await restarted.authenticate(custom)).id, own.data.id);
  assert.equal(await restarted.authenticate('x'.repeat(40)), null);
});

test('key creation validates input, reserves the administrator key and serializes duplicate checks', async t => {
  const f = await setup(t);
  for (const body of [{}, { name: '' }, { name: 'n', key: 'short' }, { name: 'n', key: 'x'.repeat(32) + '\n' }, { name: 'n', key: administrator }, { name: 'n', enabled: true }, []]) {
    assert.equal((await f.request('/v1/keys', administrator, body)).status, 400);
  }
  const results = await Promise.allSettled([f.keys.create({ name: 'a', key: custom }), f.keys.create({ name: 'b', key: custom })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'duplicate_client_key');
  assert.equal((await f.request('/v1/keys/' + (await f.keys.list()).data[0].id + '/status', administrator, { enabled: 'no' })).status, 400);
});

test('client keys can use models and chats but cannot manage keys, accounts or routing', async t => {
  const f = await setup(t), key = await f.keys.create({ name: 'client' });
  assert.equal((await f.request('/keys', null)).status, 200);
  assert.equal((await f.request('/v1/keys', null)).status, 401);
  for (const [route, body] of [['/v1/keys', undefined], ['/v1/keys', { name: 'escalation' }], ['/v1/keys/' + key.data.id + '/status', { enabled: false }], ['/v1/accounts', undefined], ['/v1/accounts/import', { credential: '{}' }], ['/v1/routing', { strategy: 'fixed' }]]) {
    const response = await f.request(route, key.api_key, body);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'admin_key_required');
  }
  assert.equal((await f.request('/v1/models', key.api_key)).status, 200);
  assert.equal((await f.chat(key.api_key)).status, 200);
  assert.equal((await f.chat(administrator)).status, 200);
});

test('different client keys share the existing account pool and maintain separate call counters', async t => {
  const f = await setup(t), a = await f.keys.create({ name: 'Cherry' }), b = await f.keys.create({ name: 'Phone' });
  const first = await (await f.chat(a.api_key)).json();
  const second = await (await f.chat(b.api_key)).json();
  const continuation = await (await f.chat(a.api_key, { conversation_id: first.conversation_id })).json();
  assert.deepEqual(f.calls, [f.ids[0], f.ids[1], f.ids[0]]);
  assert.equal(first.usage, null); assert.equal(second.usage, null);
  assert.equal(continuation.routing.strategy, 'conversation');
  const stats = (await f.keys.list()).data;
  assert.equal(stats[0].requests, 2); assert.equal(stats[0].successes, 2); assert.equal(stats[0].failures, 0);
  assert.equal(stats[1].requests, 1); assert.equal(stats[1].successes, 1);
  assert(stats.every(k => k.last_used_at));
});

test('failover counts as one client request and accepted SSE errors count as failures without replay', async t => {
  const f = await setup(t), key = await f.keys.create({ name: 'client' });
  f.before.set(f.ids[0], 'linear_session_expired');
  const reply = await (await f.chat(key.api_key, { stream: true })).text();
  assert(reply.includes('[DONE]')); assert(reply.includes('"attempt_count":2'));
  let stats = (await f.keys.list()).data[0];
  assert.equal(stats.requests, 1); assert.equal(stats.successes, 1);
  f.after.set(f.ids[1], 'linear_agent_error');
  const failed = await (await f.chat(key.api_key, { stream: true })).text();
  assert(failed.includes('linear_agent_error'));
  stats = (await f.keys.list()).data[0];
  assert.equal(stats.requests, 2); assert.equal(stats.successes, 1); assert.equal(stats.failures, 1);
  assert.deepEqual(f.calls, [f.ids[0], f.ids[1], f.ids[1]]);
});

test('validation errors do not count and disabling a queued key prevents its upstream call', async t => {
  const f = await setup(t), key = await f.keys.create({ name: 'client' });
  assert.equal((await f.chat(key.api_key, { model: 'unknown' })).status, 400);
  assert.equal((await f.keys.list()).data[0].requests, 0);
  let release, started, secondAuthenticated;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const authenticated = new Promise(resolve => { secondAuthenticated = resolve; });
  let reads = 0;
  const authenticate = f.keys.authenticate.bind(f.keys);
  f.keys.authenticate = async value => { const result = await authenticate(value); if (++reads === 2) secondAuthenticated(); return result; };
  f.setHold(async () => { started(); await gate; });
  t.after(() => release());
  const first = f.chat(key.api_key);
  await ready;
  const second = f.chat(key.api_key);
  await authenticated;
  await f.keys.setEnabled(key.data.id, false);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 401);
  assert.equal(f.calls.length, 1);
  const stats = (await f.keys.list()).data[0];
  assert.equal(stats.requests, 1); assert.equal(stats.successes, 1);
  assert.equal((await f.chat(key.api_key)).status, 401);
});

test('a corrupt key store fails closed without overwriting it or breaking the original administrator key', async t => {
  const f = await setup(t), key = await f.keys.create({ name: 'client' });
  await fs.writeFile(f.keys.file, 'broken-json');
  assert.equal((await f.request('/v1/models', key.api_key)).status, 503);
  assert.equal((await f.request('/v1/keys')).status, 503);
  assert.equal((await f.chat(administrator)).status, 200);
  await assert.rejects(new ClientKeyStore(f.runtime).initialize(), { code: 'key_store_unavailable' });
  assert.equal(await fs.readFile(f.keys.file, 'utf8'), 'broken-json');
});

test('usage bookkeeping failures do not change or replay an already successful upstream call', async t => {
  const f = await setup(t), key = await f.keys.create({ name: 'client' });
  f.keys.finish = async () => { throw new Error('Synthetic disk failure.'); };
  const response = await f.chat(key.api_key);
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'OK');
  assert.equal(f.calls.length, 1);
  assert(f.errors.some(e => e.code === 'key_store_unavailable'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { AccountStore } from '../accounts.mjs';
import { AccountRouter } from '../routing.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT, GatewayError } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';

const session = n => ({ endpoint: ENDPOINT, headers: { user: 'user-' + n, organization: 'org-' + n, cookie: 'TEST_COOKIE_' + n } });
async function setup(t, { count = 3, maxConcurrency = 1 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-routing-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-routing-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const runtime = pathToFileURL(directory + path.sep), store = new AccountStore(runtime);
  await store.initialize();
  const ids = [];
  for (let i = 0; i < count; i++) ids.push((await store.import(session(i), '账户 ' + i)).account.id);
  let clock = Date.now();
  const catalogs = new Map(ids.map(id => [id, modelEntries()]));
  const modelsProvider = async id => catalogs.get(id ?? (await store.state()).defaultAccountId) ?? modelEntries();
  const router = new AccountRouter(store, { modelsProvider, now: () => clock });
  await router.initialize();
  const calls = [], failures = new Map(), acceptedFailures = new Map();
  const server = createGateway({ apiKey: 'local-test', accountStore: store, accountRouter: router, modelsProvider, timeoutMs: 2000, maxConcurrency, clientFactory: account => ({
    call: async () => ({ aiConversation: { id: 'accessible' } }),
    chat: async (input, signal, onAccepted) => {
      calls.push({ account: account.id, input });
      if (failures.has(account.id)) throw new GatewayError(503, failures.get(account.id), 'Synthetic upstream failure.');
      const id = input.conversationId ?? randomUUID();
      await onAccepted(id);
      if (acceptedFailures.has(account.id)) throw new GatewayError(502, acceptedFailures.get(account.id), 'Synthetic accepted failure.');
      return { text: 'OK', conversationId: id };
    }
  }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, body, auth = true) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { authorization: 'Bearer local-test' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const chat = body => request('/v1/chat/completions', { model: 'linear-agent', messages: [{ role: 'user', content: '你好' }], ...body });
  return { runtime, store, router, ids, catalogs, modelsProvider, calls, failures, acceptedFailures, request, chat, advance: ms => { clock += ms; } };
}

test('automatic requests rotate A/B/C at dispatch and the cursor survives restart', async t => {
  const f = await setup(t);
  const replies = await Promise.all(Array.from({ length: 6 }, () => f.chat({}).then(r => r.json())));
  assert.deepEqual(f.calls.map(c => c.account), [...f.ids, ...f.ids]);
  assert.equal(new Set(replies.map(r => r.conversation_id)).size, 6);
  assert(replies.every(r => r.routing.strategy === 'round_robin' && r.routing.attempt_count === 1));
  const restarted = new AccountRouter(f.store, { modelsProvider: f.modelsProvider });
  await restarted.initialize();
  assert.equal((await restarted.plan({ requestedModel: 'linear-agent' })).accounts[0].id, f.ids[0]);
});

test('model catalogs form a union and only the account with evidence can serve a model', async t => {
  const f = await setup(t), model = 'anthropic/claude-sonnet-5-5';
  f.catalogs.set(f.ids[1], modelEntries({ tests: [{ requested_model: model, request_accepted: true, reply_received: true }] }));
  assert((await (await f.request('/v1/models')).json()).data.some(m => m.id === model));
  assert.equal((await (await f.request('/v1/models?account_id=' + f.ids[0])).json()).data.length, 1);
  const result = await (await f.chat({ model })).json();
  assert.equal(result.account_id, f.ids[1]);
  assert.equal((await f.chat({ model, account_id: f.ids[0] })).status, 400);
  assert.equal(f.calls.length, 1);
});

test('manual account selection and continuations do not disturb new-conversation rotation', async t => {
  const f = await setup(t);
  const first = await (await f.chat({})).json();
  assert.equal(first.account_id, f.ids[0]);
  await f.chat({ account_id: f.ids[2] });
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[1]);
  await f.chat({ conversation_id: first.conversation_id });
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[2]);
});

test('pre-accept authentication failure switches account with correct SSE metadata and binding', async t => {
  const f = await setup(t);
  f.failures.set(f.ids[0], 'linear_session_expired');
  const response = await f.chat({ stream: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-linear-account-id'), f.ids[1]);
  assert.equal(response.headers.get('x-linear-attempts'), '2');
  const chunks = (await response.text()).split('\n\n').filter(e => e.startsWith('data: ') && !e.includes('[DONE]')).map(e => JSON.parse(e.slice(6)));
  assert(chunks.every(c => c.account_id === f.ids[1] && c.routing.attempt_count === 2));
  assert.deepEqual(f.calls.map(c => c.account), f.ids.slice(0, 2));
  const conversation = response.headers.get('x-linear-conversation-id');
  assert.equal((await f.store.resolve({ conversationId: conversation })).id, f.ids[1]);
  assert.equal((await f.router.status()).accounts[0].status, 'needs_login');
});

test('retry limit is bounded and no account is attempted twice', async t => {
  const f = await setup(t);
  await f.router.setPolicy({ max_attempts: 2 });
  f.failures.set(f.ids[0], 'linear_rate_limit'); f.failures.set(f.ids[1], 'linear_rate_limit');
  const response = await f.chat({}), result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.error.code, 'linear_rate_limit');
  assert.equal(result.routing.attempt_count, 2);
  assert.deepEqual(f.calls.map(c => c.account), f.ids.slice(0, 2));
});

test('cooldown skips rate-limited accounts and expires using the saved clock', async t => {
  const f = await setup(t, { count: 2 });
  f.failures.set(f.ids[0], 'linear_rate_limit');
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[1]);
  assert.equal((await f.router.status()).accounts[0].status, 'cooldown');
  f.failures.delete(f.ids[0]);
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[1]);
  f.advance(60001);
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[0]);
});

test('accepted failures are never replayed, including authentication failures and SSE', async t => {
  const f = await setup(t);
  await f.router.setPolicy({ strategy: 'fixed' });
  for (const [code, stream] of [['linear_agent_error', false], ['linear_session_expired', true]]) {
    await f.store.import(session(0));
    f.acceptedFailures.set(f.ids[0], code);
    const response = await f.chat({ stream }), text = await response.text();
    assert(text.includes(code));
    const id = response.headers.get('x-linear-conversation-id');
    assert.equal((await f.store.resolve({ conversationId: id })).id, f.ids[0]);
  }
  assert.deepEqual(f.calls.map(c => c.account), [f.ids[0], f.ids[0]]);
});

test('explicit and continued conversations stay on their owner even when retries are enabled', async t => {
  const f = await setup(t);
  f.failures.set(f.ids[1], 'linear_rate_limit');
  assert.equal((await f.chat({ account_id: f.ids[1] })).status, 503);
  f.failures.clear();
  const first = await (await f.chat({ account_id: f.ids[0] })).json();
  await f.store.setDefault(f.ids[2]);
  f.failures.set(f.ids[0], 'linear_session_expired');
  const continuation = await f.chat({ conversation_id: first.conversation_id });
  assert.equal(continuation.status, 503);
  const count = f.calls.length;
  assert.equal((await f.chat({ account_id: f.ids[2], conversation_id: first.conversation_id })).status, 409);
  assert.equal(f.calls.length, count);
  assert.deepEqual(f.calls.map(c => c.account), [f.ids[1], f.ids[0], f.ids[0]]);
});

test('ambiguous network failures are not retried and do not block a valid account', async t => {
  const f = await setup(t);
  f.failures.set(f.ids[0], 'linear_network_error');
  const response = await f.chat({}), result = await response.json();
  assert.equal(result.error.code, 'linear_network_error');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.router.status()).accounts[0].status, 'ready');
});

test('pool membership, fixed strategy and disabling failover are persistent policy choices', async t => {
  const f = await setup(t);
  await f.router.setEnabled(f.ids[0], false);
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[1]);
  await f.router.setPolicy({ strategy: 'fixed', failover_enabled: false });
  await f.store.setDefault(f.ids[2]);
  assert.equal((await (await f.chat({})).json()).account_id, f.ids[2]);
  f.failures.set(f.ids[2], 'linear_rate_limit');
  const before = f.calls.length;
  assert.equal((await f.chat({})).status, 503);
  assert.equal(f.calls.length, before + 1);
  const restarted = new AccountRouter(f.store, { modelsProvider: f.modelsProvider });
  assert.equal((await restarted.status()).policy.strategy, 'fixed');
  assert.equal((await restarted.status()).accounts[0].enabled, false);
});

test('all unavailable accounts fail without sending, and manual cooldown reset does not unblock login', async t => {
  const f = await setup(t, { count: 1 });
  f.failures.set(f.ids[0], 'linear_session_expired');
  await f.chat({});
  await f.router.clearCooldown(f.ids[0]);
  assert.equal((await f.router.status()).accounts[0].status, 'needs_login');
  const response = await f.chat({});
  assert.equal((await response.json()).error.code, 'no_available_accounts');
  assert.equal(f.calls.length, 1);
  await f.store.import({ ...session(0), headers: { ...session(0).headers, cookie: 'REFRESHED_COOKIE' } });
  f.failures.clear();
  assert.equal((await f.chat({})).status, 200);
});

test('credential refresh is not poisoned by a stale failure or a later generic model error', async t => {
  const f = await setup(t, { count: 1 }), old = await f.store.get(f.ids[0]);
  await f.router.recordFailure(old, new GatewayError(503, 'linear_session_expired', 'expired'));
  await f.store.import(session(0));
  const fresh = await f.store.get(f.ids[0]);
  assert.notEqual(fresh.updatedAt, old.updatedAt);
  await f.router.recordFailure(old, new GatewayError(503, 'linear_session_expired', 'stale'));
  assert.equal((await f.router.status()).accounts[0].status, 'ready');
  await f.router.recordFailure(fresh, new GatewayError(502, 'linear_agent_error', 'model failed'));
  assert.equal((await f.router.status()).accounts[0].status, 'ready');
});

test('routing settings require authentication, reject invalid patches and never expose credentials', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/v1/routing', undefined, false)).status, 401);
  assert.equal((await f.request('/v1/routing', { max_attempts: 99 })).status, 400);
  assert.equal((await f.request('/v1/routing', { failover_enabled: 'yes' })).status, 400);
  assert.equal((await f.request('/v1/routing', { unexpected: true })).status, 400);
  const changed = await f.request('/v1/routing', { max_attempts: 2, cooldown_seconds: 20 });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).policy.max_attempts, 2);
  assert.equal((await f.request('/v1/accounts/' + f.ids[0] + '/routing', { enabled: false })).status, 200);
  for (const endpoint of ['/v1/accounts', '/v1/routing']) {
    const text = await (await f.request(endpoint)).text();
    assert(!text.includes('COOKIE')); assert(!text.includes('headers')); assert(!text.includes('local-test'));
  }
});

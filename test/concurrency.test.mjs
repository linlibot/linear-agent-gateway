import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Scheduler } from '../scheduler.mjs';
import { AccountStore } from '../accounts.mjs';
import { AccountRouter } from '../routing.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';
import { MockLinear } from './mock-linear.mjs';
import { client } from './openai-client.mjs';

test('scheduler enforces the outstanding cap, a FIFO global limit and per-account slots', async () => {
  const scheduler = new Scheduler({ maxConcurrency: 1, accountConcurrency: 2, maxQueue: 3 });
  const tickets = [scheduler.admit(), scheduler.admit(), scheduler.admit()];
  assert.throws(() => scheduler.admit(), e => e.status === 429 && e.code === 'queue_full');
  tickets[0].release(); tickets[0].release();
  assert.equal(scheduler.outstanding, 2);
  const order = [];
  const first = await scheduler.acquireGlobal();
  const second = scheduler.acquireGlobal().then(release => { order.push('second'); return release; });
  const aborter = new AbortController();
  const aborted = scheduler.acquireGlobal(aborter.signal).catch(error => { order.push('aborted:' + error.message); });
  const third = scheduler.acquireGlobal().then(release => { order.push('third'); return release; });
  aborter.abort(new Error('client left'));
  await aborted;
  first();
  (await second)();
  (await third)();
  assert.deepEqual(order, ['aborted:client left', 'second', 'third']);
  assert.equal(scheduler.running, 0);
  const a1 = scheduler.tryAccount('a'), a2 = scheduler.tryAccount('a');
  assert(a1 && a2);
  assert.equal(scheduler.tryAccount('a'), null);
  assert(scheduler.tryAccount('b'));
  const generation = scheduler.generation;
  const woke = scheduler.waitForRelease(generation);
  a1();
  await woke;
  assert(scheduler.tryAccount('a'));
  await scheduler.waitForRelease(generation); // a release already happened: resolves at once
});

const session = n => ({ endpoint: ENDPOINT, headers: { user: 'user-' + n, organization: 'org-' + n, cookie: 'TEST_COOKIE_' + n } });
async function setup(t, { accounts = 3, model, gateway = {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-concurrency-test-'));
  const runtime = pathToFileURL(directory + path.sep);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.shutdown();
    assert(path.basename(directory).startsWith('linear-concurrency-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new AccountStore(runtime);
  await store.initialize();
  const ids = [];
  for (let i = 0; i < accounts; i++) ids.push((await store.import(session(i))).account.id);
  const modelsProvider = async () => modelEntries();
  const router = new AccountRouter(store, { modelsProvider });
  await router.initialize();
  let active = 0, maximum = 0;
  const order = [];
  const mocks = new Map(ids.map(id => [id, new MockLinear({ model: async turn => { order.push(id); active++; maximum = Math.max(maximum, active); try { return await model(turn, id); } finally { active--; } } })]));
  const server = createGateway({ apiKey: 'test-key', accountStore: store, accountRouter: router, modelsProvider, timeoutMs: 5000, clientFactory: account => mocks.get(account.id).client(), ...gateway });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { ids, mocks, order, server, stats: () => ({ maximum }), ...client(`http://127.0.0.1:${server.address().port}`) };
}
const ask = text => ({ model: 'linear-agent', messages: [{ role: 'user', content: text }] });

test('requests on different accounts run in parallel while each account keeps its own limit', async t => {
  const f = await setup(t, { model: async () => { await sleep(150); return { markdown: 'ok' }; } });
  const started = Date.now();
  const results = await Promise.all([1, 2, 3].map(n => f.complete(ask('q' + n))));
  assert(results.every(r => r.response.status === 200));
  assert.deepEqual(f.order, f.ids, 'rotation dispatches A, B, C in order');
  assert.equal(f.stats().maximum, 3);
  assert(Date.now() - started < 400, 'three accounts served concurrently');
  assert(results.every(r => r.json.routing.attempt_count === 1));
  for (const mock of f.mocks.values()) assert(mock.maximumActiveTurns <= 1);
});

test('a single account stays serialized by default and can be raised with LINEAR_ACCOUNT_CONCURRENCY', async t => {
  const serial = await setup(t, { accounts: 1, model: async () => { await sleep(60); return { markdown: 'ok' }; } });
  const replies = await Promise.all([1, 2, 3].map(n => serial.complete(ask('q' + n))));
  assert(replies.every(r => r.response.status === 200));
  assert.equal(serial.stats().maximum, 1);
  const parallel = await setup(t, { accounts: 1, model: async () => { await sleep(60); return { markdown: 'ok' }; }, gateway: { accountConcurrency: 2 } });
  await Promise.all([1, 2, 3].map(n => parallel.complete(ask('q' + n))));
  assert.equal(parallel.stats().maximum, 2);
});

test('the global limit caps concurrent work and the outstanding cap rejects overflow without sending', async t => {
  const f = await setup(t, { accounts: 3, model: async () => { await sleep(120); return { markdown: 'ok' }; }, gateway: { maxConcurrency: 2, maxQueue: 3 } });
  const results = await Promise.all([1, 2, 3, 4].map(n => f.complete(ask('q' + n))));
  const statuses = results.map(r => r.response.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(results.find(r => r.response.status === 429).error.error.code, 'queue_full');
  assert.equal(f.stats().maximum, 2);
  assert.equal(f.order.length, 3);
});

test('time spent waiting for a busy account counts toward the request timeout and nothing is sent', async t => {
  const f = await setup(t, { accounts: 1, model: async () => { await sleep(500); return { markdown: 'slow' }; }, gateway: { timeoutMs: 300 } });
  const [first, second] = await Promise.all([f.complete(ask('first')), sleep(20).then(() => f.complete(ask('second')))]);
  assert.equal(first.response.status, 504);
  assert.equal(second.response.status, 504);
  assert.equal(second.error.error.code, 'linear_timeout');
  assert.equal(f.order.length, 1, 'the waiting request never reached Linear');
});

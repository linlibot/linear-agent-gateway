import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { AccountStore } from '../accounts.mjs';
import { AccountRouter } from '../routing.mjs';
import { ClientKeyStore } from '../client-keys.mjs';
import { ToolSessionStore } from '../tool-sessions.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT, GatewayError } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';
import { MockLinear, docText, nonceOf, toolCallBlock } from './mock-linear.mjs';
import { client } from './openai-client.mjs';

const MODEL_ID = 'anthropic/claude-sonnet-5-5';
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
const session = n => ({ endpoint: ENDPOINT, headers: { user: 'user-' + n, organization: 'org-' + n, cookie: 'TEST_COOKIE_' + n } });

// Gateways using a runtime directory are shut down (flushing their stores) before it is removed.
async function tempRuntime(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-tool-session-test-'));
  const runtime = pathToFileURL(directory + path.sep);
  runtime.servers = [];
  t.after(async () => {
    for (const server of runtime.servers) await server.shutdown();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-tool-session-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return runtime;
}

/** Every account gets its own mock Linear workspace, as real accounts do. */
async function setup(t, model, { count = 3, runtime, toolSessions, repairAttempts, existingKey } = {}) {
  runtime ??= await tempRuntime(t);
  const store = new AccountStore(runtime);
  await store.initialize();
  const ids = [];
  for (let i = 0; i < count; i++) ids.push((await store.import(session(i), '账户 ' + i)).account.id);
  const catalog = modelEntries({ tests: [{ requested_model: MODEL_ID, request_accepted: true, reply_received: true }] });
  const modelsProvider = async () => catalog;
  let clock = Date.now();
  const router = new AccountRouter(store, { modelsProvider, now: () => clock });
  await router.initialize();
  const keys = new ClientKeyStore(runtime, { adminKey: 'admin-key-' + 'x'.repeat(40) });
  await keys.initialize();
  const { api_key: clientKey, data: keyInfo } = existingKey ?? await keys.create({ name: 'Cline' });
  toolSessions ??= new ToolSessionStore(runtime);
  await toolSessions.initialize();
  const mocks = new Map(ids.map(id => [id, new MockLinear({ model: turn => model({ ...turn, account: id }) })]));
  const server = createGateway({ apiKey: 'admin-key-' + 'x'.repeat(40), accountStore: store, accountRouter: router, clientKeys: keys, modelsProvider, toolSessions, timeoutMs: 5000, chat: repairAttempts === undefined ? {} : { toolRepairAttempts: repairAttempts }, clientFactory: account => mocks.get(account.id).client() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  runtime.servers.push(server);
  return { runtime, store, router, keys, keyInfo, clientKey, ids, mocks, toolSessions, advance: ms => { clock += ms; }, ...client(`http://127.0.0.1:${server.address().port}`, clientKey) };
}

const readCall = turn => ({ markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'read_file', arguments: { path: 'a.txt' } }]) });
const task = text => ({ model: MODEL_ID, tools, messages: [{ role: 'user', content: text }] });
const withResult = (body, message, content = 'contents') => ({ ...body, messages: [...body.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content }] });

test('tool loops stay on the account that started them while rotation continues for new conversations', async t => {
  const f = await setup(t, turn => /Conversation so far/.test(docText(turn.doc)) ? readCall(turn) : { markdown: 'continued on ' + turn.account });
  const first = await f.complete(task('task one'));
  const second = await f.complete(task('task two'));
  assert.equal(first.json.account_id, f.ids[0]);
  assert.equal(second.json.account_id, f.ids[1]);
  const continued = await f.complete(withResult(task('task one'), first.message));
  assert.equal(continued.response.headers.get('x-linear-tool-session'), 'native');
  assert.equal(continued.response.headers.get('x-linear-account-id'), f.ids[0]);
  assert.equal(continued.message.content, 'continued on ' + f.ids[0]);
  assert.equal(continued.json.routing.strategy, 'tool_session');
  const third = await f.complete(task('task three'));
  assert.equal(third.json.account_id, f.ids[2], 'continuations do not move the rotation cursor');
  const sent = [...f.mocks.values()].flatMap(m => m.sends);
  assert.equal(sent.length, 4);
  assert(sent.every(s => s.input.model === MODEL_ID), 'the requested model is forwarded on every turn');
  assert.equal(f.mocks.get(f.ids[0]).conversationCount, 1);
});

test('an explicit account_id for a different account replays the full transcript on that account', async t => {
  const f = await setup(t, turn => {
    const text = docText(turn.doc);
    if (!text.includes('[tool result')) return readCall(turn);
    return { markdown: (text.includes('Conversation so far') ? 'replayed on ' : 'continued on ') + turn.account };
  });
  const first = await f.complete(task('task'));
  assert.equal(first.json.account_id, f.ids[0]);
  const moved = await f.complete({ ...withResult(task('task'), first.message), account_id: f.ids[2] });
  assert.equal(moved.response.headers.get('x-linear-tool-session'), 'replay');
  assert.equal(moved.json.account_id, f.ids[2]);
  assert.equal(moved.message.content, 'replayed on ' + f.ids[2]);
  assert.equal(f.mocks.get(f.ids[0]).sends.length, 1, 'the original account conversation was not touched');
});

test('when the session account is cooling down the transcript is replayed on a ready account', async t => {
  const f = await setup(t, turn => docText(turn.doc).includes('[tool result') ? { markdown: 'answered by ' + turn.account } : readCall(turn));
  const first = await f.complete(task('task'));
  const owner = first.json.account_id;
  await f.router.recordFailure(await f.store.get(owner), new GatewayError(429, 'linear_rate_limit', 'limited'));
  const next = await f.complete(withResult(task('task'), first.message));
  assert.equal(next.response.status, 200);
  assert.equal(next.response.headers.get('x-linear-tool-session'), 'replay');
  assert.notEqual(next.json.account_id, owner);
  assert.equal(next.message.content, 'answered by ' + next.json.account_id);
});

test('client key statistics count one request per HTTP call, including repair turns', async t => {
  const f = await setup(t, turn => turn.sendIndex === 0 ? { markdown: '```tool_calls\n{"nonce":"wrong","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}\n```' } : readCall(turn), { count: 1 });
  const result = await f.complete(task('task'));
  assert.equal(result.json.tool_protocol.repair_attempts, 1);
  const stats = (await f.keys.list()).data.find(k => k.id === f.keyInfo.id);
  assert.equal(stats.requests, 1);
  assert.equal(stats.successes, 1);
  assert.equal(stats.failures, 0);
});

test('tool sessions persist only hashes and IDs, and native continuation survives a restart', async t => {
  const runtime = await tempRuntime(t);
  const secret = 'CONFIDENTIAL_FILE_CONTENT_7741';
  const model = turn => docText(turn.doc).includes('[tool result') ? { markdown: 'continued after restart: ' + (docText(turn.doc).includes('Conversation so far') ? 'replay' : 'native') } : readCall(turn);
  const before = await setup(t, model, { runtime, count: 1 });
  const body = task('read the file containing ' + secret);
  const first = await before.complete(body);
  await before.toolSessions.flush();
  const file = await fs.readFile(new URL('tool-sessions.json', runtime), 'utf8');
  assert(!file.includes(secret));
  assert(!file.includes('COOKIE'));
  const saved = JSON.parse(file);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.sessions[0].toolCallIds, [first.message.tool_calls[0].id]);
  const resumed = await setup(t, model, { runtime, count: 1, toolSessions: new ToolSessionStore(runtime), existingKey: { api_key: before.clientKey, data: before.keyInfo } });
  const next = await resumed.complete(withResult(body, first.message, secret));
  assert.equal(next.response.headers.get('x-linear-tool-session'), 'native');
  assert.equal(next.message.content, 'continued after restart: native');
});

test('a damaged tool session ledger blocks tools but keeps ordinary chat working', async t => {
  const runtime = await tempRuntime(t);
  await fs.writeFile(new URL('tool-sessions.json', runtime), '{not json');
  const f = await setup(t, readCall, { runtime, count: 1 });
  assert.equal((await f.complete(task('x'))).response.status, 503);
  assert.equal((await f.complete({ model: MODEL_ID, messages: [{ role: 'user', content: 'hello' }] })).response.status, 200);
  const names = await fs.readdir(new URL('./', runtime));
  assert(names.some(n => n.startsWith('tool-sessions.json.corrupt-')));
});

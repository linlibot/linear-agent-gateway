import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createGateway } from '../gateway.mjs';
import { ToolSessionStore } from '../tool-sessions.mjs';
import { answerText, LinearClient } from '../upstream.mjs';
import { normalizeTools } from '../tool-protocol.mjs';
import { compileSchema } from '../json-schema.mjs';
import { MockLinear, nonceOf, toolCallBlock } from './mock-linear.mjs';
import { client } from './openai-client.mjs';
import { runTool, runCodingTask } from '../scripts/local-coding-client.mjs';

const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
const body = { model: 'linear-agent', tools, messages: [{ role: 'user', content: 'Read the file.' }] };
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-protocol-safety-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('linear-protocol-safety-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('duplicate replies and automatic continuations are isolated by client API key', async t => {
  const upstream = new MockLinear({ model: turn => turn.sendIndex === 0 ? { markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'read_file', arguments: { path: 'a' } }]) } : { markdown: 'answer-' + turn.sendIndex } });
  const clientKeys = { authenticate: async key => ['alpha', 'beta'].includes(key) ? { id: key } : null, begin: async () => {}, finish: async () => {} };
  const server = createGateway({ apiKey: 'test-key', clientKeys, clientFactory: () => upstream.client() });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = client(base, 'alpha'), b = client(base, 'beta');
  const first = await a.complete(body);
  const follow = { ...body, messages: [...body.messages, first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'contents' }] };
  const second = await a.complete(follow);
  assert.equal(second.response.headers.get('x-linear-tool-session'), 'native');
  const replay = await a.complete(follow);
  assert.equal(replay.response.headers.get('x-linear-idempotent-replay'), 'true');
  const other = await b.complete(follow);
  assert.equal(other.response.headers.get('x-linear-idempotent-replay'), null);
  assert.equal(other.response.headers.get('x-linear-tool-session'), 'replay');
  assert.notEqual(other.message.content, second.message.content);
  const explicit = await b.complete({ ...body, conversation_id: first.json.conversation_id, messages: [first.message, follow.messages.at(-1)] });
  assert.equal(explicit.response.status, 409);
});

test('dispatched request protection survives a restart without persisting messages', async t => {
  const dir = await temporary(t), url = pathToFileURL(dir + path.sep);
  const key = 'a'.repeat(64);
  const store = new ToolSessionStore(url); await store.initialize();
  await store.markDispatched(key); await store.flush();
  const resumed = new ToolSessionStore(url); await resumed.initialize();
  assert.throws(() => resumed.assertReplaySafe(key), e => e.code === 'tool_request_already_dispatched');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(new URL('tool-sessions.json', url), 'utf8')).dispatched[0]).sort(), ['expires', 'key']);
  await resumed.clearDispatched(key);
  assert.doesNotThrow(() => resumed.assertReplaySafe(key));
});

test('unsupported or malformed schema constraints fail before any upstream call', () => {
  for (const schema of [{ format: 'email' }, { $ref: 'https://example.invalid/schema' }, { $ref: '#/%broken' }, { unevaluatedProperties: false }, { pattern: '^(a+)+$' }, { minLength: -1 }, { dependentRequired: { a: 1 } }]) {
    assert.throws(() => normalizeTools([{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { value: schema } } } }]), e => e.code === 'invalid_tools');
  }
  const validate = compileSchema({ type: 'object', dependentSchemas: { a: { required: ['b'] } } });
  assert.equal(validate({ a: 1 }).valid, false);
  assert.equal(validate({ a: 1, b: 2 }).valid, true);
  assert.equal(compileSchema({ type: 'string', nullable: true, enum: ['x'] })(null).valid, false, 'nullable does not bypass enum constraints');
});

test('hidden reasoning, commentary and unknown phases never become visible text', () => {
  const part = (phase, text) => ({ type: 'text', metadata: { phase }, bodyData: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
  assert.equal(answerText([part('commentary', 'HIDDEN'), part('reasoning', 'HIDDEN'), part('new-private-phase', 'HIDDEN'), part(undefined, 'HIDDEN'), part('answer', 'visible')]), 'visible');
});

test('the example client denies local actions unless its caller explicitly approves', async () => {
  let seen = '';
  const call = { id: 'call_denied', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html","content":"x"}' } };
  let turn = 0;
  const result = await runCodingTask({ base: 'http://127.0.0.1:1/v1', key: 'fake', workspace: os.tmpdir(), stream: false, fetchImpl: async (url, options) => {
    if (turn++) seen = JSON.parse(options.body).messages.at(-1).content;
    return new Response(JSON.stringify({ choices: [{ message: turn === 1 ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: 'denied' }, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }] }));
  } });
  assert.equal(seen, 'The user denied this action.');
  assert.equal(result.final, 'denied');
});

test('local path checks reject NTFS streams before writing a file', async t => {
  const dir = await temporary(t);
  await assert.rejects(runTool(dir, 'write_file', { path: 'file.txt:hidden', content: 'x' }), /relative/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('resolver errors and partial mutation results are never retried as input coercion failures', async t => {
  for (const result of [
    { errors: [{ message: 'A resolver failed after starting work', extensions: { code: 'INVALID_INPUT' } }] },
    { data: { aiConversationSendMessage: { success: true } }, errors: [{ message: 'partial result', extensions: { code: 'UNAUTHENTICATED' } }] },
  ]) {
    let sends = 0;
    const upstream = new LinearClient({ headers: {} }, { fetchImpl: async () => { sends++; return new Response(JSON.stringify(result)); } });
    const server = createGateway({ apiKey: 'test-key', clientFactory: () => upstream });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.shutdown());
    const f = client(`http://127.0.0.1:${server.address().port}`);
    assert.equal((await f.complete(body)).response.status, 502);
    assert.equal((await f.complete(body)).response.status, 409);
    assert.equal(sends, 1, 'no format fallback, repair or client retry may repeat an uncertain mutation');
  }
});

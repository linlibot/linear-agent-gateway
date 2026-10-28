import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '../gateway.mjs';
import { detailedReadState } from '../upstream.mjs';
import { promptFormatState } from '../chat-completions.mjs';
import { MockLinear, docText, labelledBlocks, nonceOf, toolCallBlock } from './mock-linear.mjs';
import { accumulate, client, parseSse } from './openai-client.mjs';

const tool = (name, properties, required = Object.keys(properties)) => ({ type: 'function', function: { name, description: `${name} on the user's machine`, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const tools = [
  tool('write_file', { path: { type: 'string' }, content: { type: 'string' } }),
  tool('read_file', { path: { type: 'string' } }),
  tool('run_command', { command: { type: 'string' } }),
];
const user = text => ({ role: 'user', content: text });
const base = { model: 'linear-agent', tools };

async function setup(t, model, { gateway = {}, mock = {} } = {}) {
  detailedReadState.reset();
  promptFormatState.reset();
  const upstream = new MockLinear({ model, ...mock });
  const server = createGateway({ apiKey: 'test-key', timeoutMs: 5000, clientFactory: () => upstream.client(), ...gateway });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  return { upstream, server, url, ...client(url) };
}

/** Script helper: returns the scripted reply for the n-th Linear send. */
const script = (...steps) => turn => {
  const step = steps[turn.sendIndex];
  if (!step) throw new Error('Unexpected Linear send #' + turn.sendIndex);
  return typeof step === 'function' ? step(turn) : step;
};
const call = (name, args, intro) => turn => ({ markdown: toolCallBlock(nonceOf(turn.doc), Array.isArray(name) ? name : [{ name, arguments: args }], intro) });
const reply = markdown => ({ markdown });

test('plain chat through the mock Linear upstream keeps the original JSON and SSE shapes', async t => {
  const { complete, upstream } = await setup(t, () => ({ markdown: 'Hello **there**', chunks: 2 }));
  const json = await complete({ model: 'linear-agent', messages: [user('hi')] });
  assert.equal(json.response.status, 200);
  assert.equal(json.message.content, 'Hello **there**');
  assert.equal(json.finish, 'stop');
  assert.equal(json.json.usage, null);
  assert.equal(json.json.client_tools, undefined);
  assert.deepEqual(upstream.sends[0].input.bodyData, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] });
  const stream = await complete({ model: 'linear-agent', messages: [user('hi')], stream: true, stream_options: { include_usage: true } });
  assert.equal(stream.message.content, 'Hello **there**');
  assert.equal(stream.finish, 'stop');
  assert.equal(stream.chunks.at(-1).usage, null);
  assert(!stream.chunks.some(c => c.choices?.[0]?.delta?.tool_calls));
});

test('a single client tool call becomes OpenAI tool_calls with finish_reason tool_calls; Linear never receives a tools field', async t => {
  const { complete, upstream } = await setup(t, script(call('write_file', { path: 'index.html', content: '<!doctype html><title>Hi</title>' }, "I'll create it.")));
  const result = await complete({ ...base, messages: [{ role: 'system', content: 'You are a coding agent.' }, user('Create index.html')] });
  assert.equal(result.response.status, 200);
  assert.equal(result.finish, 'tool_calls');
  assert.equal(result.message.content, "I'll create it.");
  const [toolCall] = result.message.tool_calls;
  assert.match(toolCall.id, /^call_[A-Za-z0-9]{24}$/);
  assert.equal(toolCall.type, 'function');
  assert.equal(toolCall.function.name, 'write_file');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { path: 'index.html', content: '<!doctype html><title>Hi</title>' });
  assert.equal(result.response.headers.get('x-linear-client-tools'), 'structured-output; experimental');
  assert.equal(result.response.headers.get('x-linear-tool-session'), 'new');
  assert.equal(result.json.client_tools.experimental, true);
  assert.deepEqual(result.json.tool_protocol, { upstream_turns: 1, repair_attempts: 0, tool_calls: 1, dropped_tool_calls: 0 });
  const input = upstream.sends[0].input;
  assert.deepEqual(Object.keys(input).sort(), ['bodyData', 'context', 'conversationId', 'resume', 'userMessageId']);
  const prompt = docText(input.bodyData);
  assert.match(prompt, /"name":"write_file"/);
  assert.match(prompt, /Nonce for this reply: lgw-/);
  assert(labelledBlocks(input.bodyData).some(b => b.label === '[system message from the application]' && b.code === 'You are a coding agent.'));
});

test('several calls in one reply keep their order and receive distinct IDs', async t => {
  const { complete } = await setup(t, script(call([{ name: 'read_file', arguments: { path: 'a.js' } }, { name: 'read_file', arguments: { path: 'b.js' } }, { name: 'run_command', arguments: { command: 'npm test' } }])));
  const result = await complete({ ...base, messages: [user('Inspect a.js and b.js, then run the tests')] });
  assert.equal(result.finish, 'tool_calls');
  assert.deepEqual(result.message.tool_calls.map(c => [c.function.name, JSON.parse(c.function.arguments)]), [['read_file', { path: 'a.js' }], ['read_file', { path: 'b.js' }], ['run_command', { command: 'npm test' }]]);
  assert.equal(new Set(result.message.tool_calls.map(c => c.id)).size, 3);
  assert.equal(result.message.content, null);
});

test('tool results continue the same Linear conversation and only new messages are sent', async t => {
  const { complete, upstream } = await setup(t, script(
    call('read_file', { path: 'package.json' }),
    turn => {
      const results = labelledBlocks(turn.doc).filter(b => b.label.startsWith('[tool result'));
      assert.equal(results.length, 1);
      assert.match(results[0].label, /\(read_file\)/);
      return reply('The project is called demo. ' + results[0].code.length + ' bytes read.');
    },
  ));
  const messages = [{ role: 'system', content: 'SYSTEM PROMPT TEXT' }, user('What is the project name?')];
  const first = await complete({ ...base, messages });
  const id = first.message.tool_calls[0].id;
  const second = await complete({ ...base, messages: [...messages, first.message, { role: 'tool', tool_call_id: id, content: '{"name":"demo"}' }] });
  assert.equal(second.response.status, 200);
  assert.equal(second.finish, 'stop');
  assert.equal(second.message.content, 'The project is called demo. 15 bytes read.');
  assert.equal(second.response.headers.get('x-linear-tool-session'), 'native');
  assert.equal(upstream.conversationCount, 1);
  assert.equal(upstream.sends.length, 2);
  assert.equal(upstream.sends[1].conversationId, upstream.sends[0].conversationId);
  const delta = docText(upstream.sends[1].input.bodyData);
  assert(!delta.includes('SYSTEM PROMPT TEXT'), 'native continuation does not resend history');
  assert(!delta.includes('Gateway protocol for client tools'), 'protocol is sent once per Linear conversation');
  assert.match(delta, new RegExp(`\\[tool result for ${id} \\(read_file\\)`));
});

test('three tool rounds followed by a final answer complete in one Linear conversation', async t => {
  const { complete, upstream } = await setup(t, script(
    call('write_file', { path: 'app.py', content: 'print(1)\n' }),
    call('run_command', { command: 'python app.py' }),
    call('write_file', { path: 'app.py', content: 'print(2)\n' }),
    reply('Updated app.py; it now prints 2.'),
  ));
  const messages = [user('Create app.py, run it, then make it print 2')];
  const ids = [];
  for (const output of ['wrote 9 bytes', '1', 'wrote 9 bytes']) {
    const result = await complete({ ...base, messages, stream: true });
    assert.equal(result.finish, 'tool_calls');
    ids.push(result.message.tool_calls[0].id);
    messages.push(result.message, { role: 'tool', tool_call_id: result.message.tool_calls[0].id, content: output });
  }
  const final = await complete({ ...base, messages, stream: true });
  assert.equal(final.finish, 'stop');
  assert.equal(final.message.content, 'Updated app.py; it now prints 2.');
  assert.equal(new Set(ids).size, 3);
  assert.equal(upstream.conversationCount, 1);
  assert.equal(upstream.sends.length, 4);
});

test('a failed tool result reaches the model, which can recover with a different call', async t => {
  const { complete, upstream } = await setup(t, script(
    call('write_file', { path: '/etc/app.conf', content: 'x' }),
    turn => {
      assert(labelledBlocks(turn.doc).some(b => b.code.includes('EACCES')));
      return call('write_file', { path: 'app.conf', content: 'x' }, 'That location is not writable; writing to the project instead.')(turn);
    },
    reply('Saved app.conf in the project directory.'),
  ));
  const messages = [user('Save the config')];
  const first = await complete({ ...base, messages });
  messages.push(first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'Error: EACCES: permission denied, open /etc/app.conf' });
  const second = await complete({ ...base, messages });
  assert.equal(second.finish, 'tool_calls');
  assert.equal(JSON.parse(second.message.tool_calls[0].function.arguments).path, 'app.conf');
  messages.push(second.message, { role: 'tool', tool_call_id: second.message.tool_calls[0].id, content: 'ok' });
  const third = await complete({ ...base, messages });
  assert.equal(third.message.content, 'Saved app.conf in the project directory.');
  assert.equal(upstream.conversationCount, 1);
});

test('protocol and schema problems are repaired in the same conversation before anything reaches the client', async t => {
  const { complete, upstream } = await setup(t, script(
    turn => ({ markdown: 'Creating it.\n\n```tool_calls\n{"nonce":"' + nonceOf(turn.doc) + '","tool_calls":[{"name":"write_file","arguments":{"path":"index.html"}}]}\n```' }),
    turn => {
      const text = docText(turn.doc);
      assert.match(text, /Previous reply could not be used/);
      assert.match(text, /arguments \/content is required/);
      return call('write_file', { path: 'index.html', content: '<html></html>' })(turn);
    },
  ));
  const result = await complete({ ...base, messages: [user('Create index.html')] });
  assert.equal(result.response.status, 200);
  assert.equal(result.finish, 'tool_calls');
  assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { path: 'index.html', content: '<html></html>' });
  assert.equal(result.message.content, 'Creating it.');
  assert.equal(result.json.tool_protocol.repair_attempts, 1);
  assert.equal(upstream.sends.length, 2);
  assert.equal(upstream.conversationCount, 1);
});

test('when repairs are exhausted the request fails with tool_call_invalid and no tool calls', async t => {
  const broken = turn => ({ markdown: '```tool_calls\n{"nonce":"' + nonceOf(turn.doc) + '","tool_calls":[{"name":"format_disk","arguments":{}}]}\n```' });
  const { complete, upstream } = await setup(t, script(broken, broken));
  const result = await complete({ ...base, messages: [user('do it')] });
  assert.equal(result.response.status, 502);
  assert.equal(result.error.error.code, 'tool_call_invalid');
  assert.match(result.error.error.message, /"format_disk" is not a client tool/);
  assert.match(result.error.error.message, /nothing was sent to the client/);
  assert.equal(upstream.sends.length, 2);
  const streamed = await setup(t, script(broken), { gateway: { chat: { toolRepairAttempts: 0 } } });
  const sse = await streamed.post({ ...base, messages: [user('do it')], stream: true });
  const { chunks, done } = parseSse(await sse.text());
  assert(done);
  assert.equal(chunks.at(-1).error.code, 'tool_call_invalid');
  assert(!chunks.some(c => c.choices?.[0]?.delta?.tool_calls));
  assert.equal(streamed.upstream.sends.length, 1);
});

test('tool_choice none, auto, required, a named function and allowed_tools are described and enforced', async t => {
  const { complete, upstream } = await setup(t, script(
    turn => { assert.match(docText(turn.doc), /Client tools are disabled for this reply/); return { markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'read_file', arguments: { path: 'x' } }]) }; },
    reply('Plain answer.'),
    turn => { assert.match(docText(turn.doc), /You must call at least one client tool/); return reply('I would rather explain.'); },
    turn => { assert.match(docText(turn.doc), /must call at least one client tool, but it contains no tool_calls block/); return call('read_file', { path: 'x' })(turn); },
    turn => { assert.match(docText(turn.doc), /You must call the client tool "run_command"/); return call('read_file', { path: 'x' })(turn); },
    turn => { assert.match(docText(turn.doc), /calls "read_file", which is not allowed/); return call('run_command', { command: 'ls' })(turn); },
    turn => { assert.match(docText(turn.doc), /You may only call these client tools in this reply: read_file/); return call('read_file', { path: 'y' })(turn); },
  ));
  const none = await complete({ ...base, tool_choice: 'none', messages: [user('a')] });
  assert.equal(none.finish, 'stop');
  assert.equal(none.message.tool_calls, undefined);
  const auto = await complete({ ...base, tool_choice: 'auto', messages: [user('b')] });
  assert.equal(auto.message.content, 'Plain answer.');
  const required = await complete({ ...base, tool_choice: 'required', messages: [user('c')] });
  assert.equal(required.finish, 'tool_calls');
  const named = await complete({ ...base, tool_choice: { type: 'function', function: { name: 'run_command' } }, messages: [user('d')] });
  assert.equal(named.message.tool_calls[0].function.name, 'run_command');
  const allowed = await complete({ ...base, tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'read_file' } }] } }, messages: [user('e')] });
  assert.equal(allowed.message.tool_calls[0].function.name, 'read_file');
  assert.equal(upstream.sends.length, 7);
});

test('SSE sends role, progressive text, then OpenAI tool_call deltas, finish_reason, usage and DONE', async t => {
  const big = 'x'.repeat(20000) + '😀'.repeat(3000) + '\n<title>Done</title>';
  const intro = 'First I will explain the plan.\n\nThen I will write the file.';
  const { post } = await setup(t, script(turn => ({ markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'write_file', arguments: { path: 'big.html', content: big } }, { name: 'read_file', arguments: { path: 'big.html' } }], intro), chunks: 6 })));
  const response = await post({ ...base, messages: [user('write a big file')], stream: true, stream_options: { include_usage: true } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const { chunks, done } = parseSse(await response.text());
  assert(done);
  const message = accumulate(chunks);
  assert.equal(message.finish, 'tool_calls');
  assert.equal(message.content, intro);
  assert.deepEqual(message.toolCalls.map(c => c.function.name), ['write_file', 'read_file']);
  assert.equal(JSON.parse(message.toolCalls[0].function.arguments).content, big);
  const argumentDeltas = chunks.filter(c => c.choices?.[0]?.delta?.tool_calls?.[0]?.index === 0 && c.choices[0].delta.tool_calls[0].id === undefined);
  assert(argumentDeltas.length > 1, 'large arguments are split into several deltas');
  const finishChunk = chunks.find(c => c.choices?.[0]?.finish_reason);
  assert(finishChunk.streaming.progressive_chunks >= 1, 'text before the tool block was streamed while Linear was still generating');
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(chunks.at(-1).usage, null);
});

test('a client disconnect cancels Linear, and the identical interrupted tool request is blocked', async t => {
  let release;
  const { complete, post, upstream } = await setup(t, script(
    call('read_file', { path: 'a' }),
    () => { setTimeout(() => release?.(), 0); return { markdown: 'never delivered', waitPolls: 1e9 }; },
    turn => { assert.match(docText(turn.doc), /Conversation so far/); return reply('Fresh answer after replay.'); },
  ), { gateway: { timeoutMs: 10000 } });
  const messages = [user('read a')];
  const first = await complete({ ...base, messages });
  messages.push(first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'A' });
  const controller = new AbortController();
  const started = new Promise(resolve => { release = resolve; });
  const pending = post({ ...base, messages, stream: true }, { signal: controller.signal }).then(r => r.text()).catch(error => error.name);
  await started;
  await sleep(20);
  controller.abort();
  assert.equal(await pending, 'AbortError');
  for (let i = 0; i < 100 && !upstream.cancels.length; i++) await sleep(10);
  assert.deepEqual(upstream.cancels, [upstream.sends[1].conversationId]);
  const retry = await complete({ ...base, messages });
  assert.equal(retry.response.status, 409);
  assert.equal(retry.error.error.code, 'tool_request_already_dispatched');
  assert.equal(upstream.sends.length, 2);
});

test('an accepted tool request that times out is cancelled and never replayed', async t => {
  const { complete, upstream } = await setup(t, () => ({ markdown: 'late', waitPolls: 1e9 }), { gateway: { timeoutMs: 300 } });
  const result = await complete({ ...base, messages: [user('slow')] });
  assert.equal(result.response.status, 504);
  assert.equal(result.error.error.code, 'linear_timeout');
  assert.equal(upstream.sends.length, 1);
  for (let i = 0; i < 50 && !upstream.cancels.length; i++) await sleep(10);
  assert.equal(upstream.cancels.length, 1);
});

test('an identical request in flight gets 409, and a repeated completed tool-result request is answered from the duplicate cache', async t => {
  const { complete, upstream } = await setup(t, script(
    call('read_file', { path: 'a' }),
    turn => ({ ...call('write_file', { path: 'a', content: 'b' })(turn), waitPolls: 30 }),
    reply('fresh reply for a regenerated request'),
    reply('second fresh reply'),
    reply('different request'),
  ), { gateway: { maxConcurrency: 4 } });
  const first = await complete({ ...base, messages: [user('edit a')] });
  const body = { ...base, messages: [user('edit a'), first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'A' }] };
  const [one, two] = await Promise.all([complete(body), sleep(5).then(() => complete(body))]);
  assert.deepEqual([one.response.status, two.response.status].sort(), [200, 409]);
  const [ok, duplicate] = one.response.status === 200 ? [one, two] : [two, one];
  assert.equal(duplicate.error.error.code, 'duplicate_request_in_progress');
  assert.equal(duplicate.response.headers.get('retry-after'), '5');
  assert.equal(upstream.sends.length, 2);
  const again = await complete({ ...body, stream: true });
  assert.equal(again.response.headers.get('x-linear-idempotent-replay'), 'true');
  assert.deepEqual(again.message.tool_calls, ok.message.tool_calls);
  assert.equal(again.chunks.find(c => c.choices?.[0]?.finish_reason).idempotent_replay, true);
  assert.equal(upstream.sends.length, 2, 'the cached reply did not contact Linear');
  const bypass = await complete(body, { headers: { 'cache-control': 'no-cache' } });
  assert.equal(bypass.response.status, 409, 'cache-control cannot bypass the dispatched request ledger');
  const regenerate = await complete({ ...base, messages: [user('edit a')] });
  assert.equal(regenerate.message.content, 'fresh reply for a regenerated request', 'requests ending with a user message are never served from cache');
  const changed = await complete({ ...base, messages: [user('something else')] });
  assert.equal(changed.message.content, 'second fresh reply');
  assert.equal(upstream.sends.length, 4);
});

test('Linear built-in tool use is reported separately and missing local changes are stated explicitly', async t => {
  const { complete } = await setup(t, script(
    { markdown: 'I created index.html in /workspace/site.', internalTools: ['CreateSandbox', 'Bash'] },
    reply("I've created index.html for you with a blue heading."),
    reply("I've created index.html for you."),
  ));
  const cloud = await complete({ ...base, messages: [user('create index.html')] });
  assert.equal(cloud.finish, 'stop');
  assert.equal(cloud.message.tool_calls, undefined);
  assert.deepEqual(cloud.json.linear_internal_tool_calls, ['CreateSandbox', 'Bash']);
  assert.match(cloud.message.content, /^I created index.html in \/workspace\/site\.\n\n\[网关提示\] 本轮没有发出任何客户端工具调用/);
  assert.match(cloud.message.content, /Linear's cloud environment, not on your computer/);
  const claim = await complete({ ...base, messages: [user('create index.html')] });
  assert.match(claim.message.content, /no client tool call was issued, so no local file was created or changed/);
  const call = { id: 'call_previous', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html","content":"x"}' } };
  const afterRealWrite = await complete({ ...base, messages: [user('create index.html'), { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'call_previous', content: 'ok' }] });
  assert.equal(afterRealWrite.message.content, "I've created index.html for you.");
});

test('the detailed read query falls back to the original query when Linear rejects its extra fields', async t => {
  const { complete, upstream } = await setup(t, script(call('read_file', { path: 'a' }), reply('done')), { mock: { detailedRead: false } });
  const first = await complete({ ...base, messages: [user('read a')] });
  assert.equal(first.finish, 'tool_calls');
  assert.equal(detailedReadState.supported, false);
  const readsBefore = upstream.reads;
  await complete({ ...base, messages: [user('read a'), first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'A' }] });
  assert(upstream.reads > readsBefore);
});

test('a tool block whose info string Linear dropped is still recognised by its nonce', async t => {
  const { complete } = await setup(t, script(call('read_file', { path: 'a' })), { mock: { keepFenceInfo: false } });
  const result = await complete({ ...base, messages: [user('read a')] });
  assert.equal(result.finish, 'tool_calls');
});

test('sampling parameters are accepted and reported as ignored; strict mode rejects them', async t => {
  const { complete } = await setup(t, script(reply('ok')));
  const result = await complete({ ...base, messages: [user('x')], temperature: 0, max_completion_tokens: 1000, parallel_tool_calls: true, top_p: 1, user: 'u', n: 1 });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json.ignored_parameters, ['temperature', 'max_completion_tokens', 'top_p', 'user', 'n']);
  assert.equal(result.response.headers.get('x-linear-ignored-parameters'), 'temperature,max_completion_tokens,top_p,user,n');
  for (const bad of [{ n: 2 }, { response_format: { type: 'json_object' } }, { unknown_field: 1 }, { logprobs: true }]) {
    const rejected = await complete({ ...base, messages: [user('x')], ...bad });
    assert.equal(rejected.response.status, 400);
  }
  const strict = await setup(t, script(reply('ok')), { gateway: { chat: { strictParameters: true } } });
  assert.equal((await strict.complete({ ...base, messages: [user('x')], temperature: 0 })).response.status, 400);
});

test('parallel_tool_calls false forwards one call and tells Linear which calls were not executed', async t => {
  const { complete, upstream } = await setup(t, script(
    call([{ name: 'read_file', arguments: { path: 'a' } }, { name: 'read_file', arguments: { path: 'b' } }]),
    turn => { assert.match(docText(turn.doc), /These calls were NOT executed/); assert.match(docText(turn.doc), /"path":"b"/); return reply('ok'); },
  ));
  const messages = [user('read both')];
  const first = await complete({ ...base, messages, parallel_tool_calls: false });
  assert.equal(first.message.tool_calls.length, 1);
  assert.equal(first.json.tool_protocol.dropped_tool_calls, 1);
  assert.match(docText(upstream.sends[0].input.bodyData), /Put exactly one call in the array/);
  await complete({ ...base, messages: [...messages, first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'A' }], parallel_tool_calls: false });
});

test('explicit conversation_id continuations accept the tool results for that conversation only', async t => {
  const { complete, upstream } = await setup(t, script(call('read_file', { path: 'a' }), reply('A has 1 line.')));
  const first = await complete({ ...base, messages: [user('read a')] });
  const conversation = first.json.conversation_id;
  const mismatch = await complete({ ...base, conversation_id: conversation, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_other', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_other', content: 'x' }] });
  assert.equal(mismatch.response.status, 409);
  const next = await complete({ ...base, conversation_id: conversation, messages: [first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'line 1' }] });
  assert.equal(next.message.content, 'A has 1 line.');
  assert.equal(upstream.conversationCount, 1);
});

test('Roo Code and Cline (AI SDK) request shapes are accepted unchanged', async t => {
  const { complete, upstream } = await setup(t, script(
    call('read_file', { path: 'src/app.ts' }),
    turn => {
      const labels = labelledBlocks(turn.doc).map(b => b.label);
      assert.deepEqual(labels.slice(0, 2), [`[tool result for ${turn.doc && labels[0].match(/call_\w+/)[0]} (read_file), returned by the application]`, '[user]']);
      assert(labelledBlocks(turn.doc)[1].code.includes('<environment_details>'));
      return reply('Read it.');
    },
    call('read_file', { path: 'b' }),
  ));
  // Roo Code (openai provider): system as cached content parts, strict schemas, parallel tool calls,
  // temperature 0, usage in stream, max_completion_tokens, environment details after tool results.
  const roo = {
    model: 'linear-agent', temperature: 0, stream: true, stream_options: { include_usage: true }, parallel_tool_calls: true, max_completion_tokens: 16384,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', strict: true, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
    messages: [{ role: 'system', content: [{ type: 'text', text: 'You are Roo.', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: [{ type: 'text', text: '<task>read app.ts</task>' }, { type: 'text', text: '<environment_details>cwd</environment_details>', cache_control: { type: 'ephemeral' } }] }],
  };
  const first = await complete(roo);
  assert.equal(first.finish, 'tool_calls');
  const second = await complete({ ...roo, messages: [...roo.messages, first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'export {}' }, { role: 'user', content: [{ type: 'text', text: '<environment_details>after</environment_details>' }] }] });
  assert.equal(second.message.content, 'Read it.');
  assert.equal(second.response.headers.get('x-linear-tool-session'), 'native');
  // Cline (@ai-sdk/openai-compatible): max_tokens, tool_choice auto, assistant content "" with tool calls.
  const cline = { model: 'linear-agent', max_tokens: 8192, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, tools: roo.tools, messages: [{ role: 'system', content: 'You are Cline.' }, { role: 'user', content: 'read b' }, { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'toolu_01', content: 'A' }, { role: 'user', content: 'now b' }] };
  const third = await complete(cline);
  assert.equal(third.finish, 'tool_calls');
  assert.deepEqual(JSON.parse(third.message.tool_calls[0].function.arguments), { path: 'b' });
  assert.equal(third.response.headers.get('x-linear-tool-session'), 'replay');
  assert.match(docText(upstream.sends[2].input.bodyData), /\[assistant requested client tools\][\s\S]*"id":"toolu_01"/);
});

test('if Linear rejects rich-text input, the same content is resent once as plain text and plain is used afterwards', async t => {
  const { complete, upstream } = await setup(t, script(
    turn => { assert.equal(turn.doc.content.length, 1); assert.match(docText(turn.doc), /```text\nCreate index.html\n```/); return call('write_file', { path: 'index.html', content: 'x' })(turn); },
    turn => { assert.equal(turn.doc.content.length, 1); return reply('done'); },
  ), { mock: { richInput: false } });
  const first = await complete({ ...base, messages: [user('Create index.html')] });
  assert.equal(first.finish, 'tool_calls');
  assert.equal(upstream.rejectedSends, 1);
  assert.equal(promptFormatState.richRejected, true);
  const second = await complete({ ...base, messages: [user('Create index.html'), first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'ok' }] });
  assert.equal(second.message.content, 'done');
  assert.equal(upstream.rejectedSends, 1, 'no second rejected attempt');
});

test('an ambiguous upstream rejection is never blindly replayed', async t => {
  const { complete, upstream } = await setup(t, script(
    call('read_file', { path: 'a' }),
    turn => { assert.match(docText(turn.doc), /Conversation so far/); return reply('replayed'); },
  ));
  const first = await complete({ ...base, messages: [user('read a')] });
  const body = { ...base, messages: [user('read a'), first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'A' }] };
  const originalSend = upstream.send.bind(upstream);
  upstream.send = async input => input.conversationId === upstream.sends[0].conversationId ? new Response(JSON.stringify({ errors: [{ message: 'Conversation not found', extensions: { code: 'NOT_FOUND' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) : originalSend(input);
  const failed = await complete(body, { headers: { 'cache-control': 'no-cache' } });
  assert.equal(failed.response.status, 502);
  const retried = await complete(body);
  assert.equal(retried.response.status, 409);
  assert.equal(retried.error.error.code, 'tool_request_already_dispatched');
  assert.equal(upstream.sends.length, 1);
});

test('an explicit conversation_id is continued even when LINEAR_TOOL_CONTINUATION=replay', async t => {
  const { complete, upstream } = await setup(t, script(call('read_file', { path: 'a' }), reply('continued')), { gateway: { chat: { toolContinuation: 'replay' } } });
  const first = await complete({ ...base, messages: [user('read a')] });
  const next = await complete({ ...base, conversation_id: first.json.conversation_id, messages: [first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'A' }] });
  assert.equal(next.message.content, 'continued');
  assert.equal(upstream.conversationCount, 1);
  assert.equal(upstream.sends[1].conversationId, first.json.conversation_id);
});

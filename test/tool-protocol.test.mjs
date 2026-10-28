import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSchema, schemaProblems, stableStringify } from '../json-schema.mjs';
import { normalizeTools, normalizeToolChoice, parseToolReply, toOpenAiToolCalls, newNonce, newToolCallId } from '../tool-protocol.mjs';
import { normalizeMessages, prefixHashes, canonicalMessage } from '../messages.mjs';
import { DocBuilder, scanFences, textDoc } from '../rich-doc.mjs';
import { initialDocument, continuationDocument } from '../prompt-builder.mjs';
import { richText } from '../upstream.mjs';

const fn = (name, parameters, extra = {}) => ({ type: 'function', function: { name, description: name + ' tool', parameters, ...extra } });
const writeFile = fn('write_file', { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false });
const readFile = fn('read_file', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false });
const tools = normalizeTools([writeFile, readFile]);
const auto = normalizeToolChoice('auto', tools);
const nonce = 'lgw-testnonce22';
const block = (calls, value = nonce, info = 'tool_calls') => '```' + info + '\n' + JSON.stringify({ nonce: value, tool_calls: calls }) + '\n```';
const parse = (text, options = {}) => parseToolReply([text], { tools, choice: auto, parallel: true, nonce, ...options });

test('JSON Schema validator covers the keywords used by tool schemas', () => {
  const validate = compileSchema({
    type: 'object', required: ['mode', 'items'], additionalProperties: false,
    properties: {
      mode: { enum: ['read', 'write'] }, count: { type: 'integer', minimum: 1, maximum: 5 }, tag: { type: ['string', 'null'], pattern: '^[a-z]+$' },
      items: { type: 'array', minItems: 1, uniqueItems: true, items: { $ref: '#/$defs/item' } },
      choice: { oneOf: [{ type: 'string' }, { type: 'number' }] }, nested: { type: 'object', nullable: true, properties: { ok: { const: true } } },
    },
    $defs: { item: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 3 } } } },
  });
  assert.equal(validate({ mode: 'read', items: [{ name: 'a' }], count: 2, tag: null, choice: 1, nested: null }).valid, true);
  const result = validate({ mode: 'delete', items: [{ name: 'long' }, { name: 'long' }], count: 1.5, tag: 'ABC', extra: 1, choice: true, nested: { ok: false } });
  const paths = result.errors.map(e => e.path);
  for (const path of ['/mode', '/items/0/name', '/items/1', '/count', '/tag', '/extra', '/choice', '/nested/ok']) assert(paths.includes(path), path + ' missing in ' + paths.join(','));
  assert.equal(validate({ items: [] }).errors.some(e => e.path === '/mode' && /required/.test(e.message)), true);
  assert.deepEqual(schemaProblems({ type: 'strng' }).length, 1);
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 1 }] }), '{"a":[{"c":1,"d":2}],"b":1}');
});

test('tool definitions are validated strictly and keep their schemas', () => {
  assert.deepEqual(tools.map(t => t.name), ['write_file', 'read_file']);
  assert.equal(normalizeTools([fn('noargs')]).length, 1);
  assert.deepEqual(normalizeTools([{ type: 'function', function: { name: 'x' } }])[0].parameters, { type: 'object', properties: {} });
  for (const bad of [[{ type: 'custom', custom: { name: 'x' } }], [fn('bad name', {})], [writeFile, writeFile], [fn('x', { type: 'string' })], [fn('x', { type: 'object', properties: { a: { type: 'nope' } } })], 'tools']) {
    assert.throws(() => normalizeTools(bad), e => e.code === 'invalid_tools');
  }
  assert.equal(normalizeTools([fn('s', { type: 'object' }, { strict: true })])[0].strict, true);
});

test('tool_choice supports auto, none, required, a named function and allowed_tools', () => {
  assert.equal(normalizeToolChoice(undefined, tools).mode, 'auto');
  assert.equal(normalizeToolChoice(undefined, []).mode, 'none');
  assert.equal(normalizeToolChoice('none', tools).mode, 'none');
  assert.equal(normalizeToolChoice('required', tools).mode, 'required');
  assert.deepEqual(normalizeToolChoice({ type: 'function', function: { name: 'read_file' } }, tools), { mode: 'required', allowed: ['read_file'], forced: 'read_file', restricted: true });
  assert.deepEqual(normalizeToolChoice({ type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [{ type: 'function', function: { name: 'read_file' } }] } }, tools).allowed, ['read_file']);
  for (const bad of ['always', { type: 'function', function: { name: 'missing' } }, { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } }]) assert.throws(() => normalizeToolChoice(bad, tools), e => e.code === 'invalid_tool_choice');
  assert.throws(() => normalizeToolChoice('required', []), e => e.code === 'invalid_tool_choice');
});

test('a valid block becomes ordered tool calls with unique OpenAI IDs and canonical JSON arguments', () => {
  const result = parse('I will write and then read it.\n\n' + block([{ name: 'write_file', arguments: { path: 'a.txt', content: 'x\n```\ny' } }, { name: 'read_file', arguments: '{"path":"a.txt"}' }]));
  assert.deepEqual(result.problems, []);
  assert.equal(result.content, 'I will write and then read it.');
  const calls = toOpenAiToolCalls(result.toolCalls);
  assert.deepEqual(calls.map(c => c.function.name), ['write_file', 'read_file']);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.txt', content: 'x\n```\ny' });
  assert.equal(calls[1].function.arguments, '{"path":"a.txt"}');
  assert(calls.every(c => /^call_[A-Za-z0-9]{24}$/.test(c.id) && c.type === 'function'));
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(new Set(Array.from({ length: 200 }, newToolCallId)).size, 200);
  assert.match(newNonce(), /^lgw-[a-f0-9]{36}$/);
});

test('ordinary prose, examples and code are never turned into tool calls', () => {
  for (const text of [
    'Here is the file you asked for:\n\n```html\n<title>x</title>\n```',
    'Use JSON like {"tool_calls":[{"name":"write_file"}]} to call tools.',
    'Example:\n\n```json\n{"tool_calls":[{"name":"write_file","arguments":{"path":"a","content":"b"}}]}\n```',
    'I have written the file write_file(path="a.txt").',
  ]) {
    const result = parse(text);
    assert.deepEqual(result.toolCalls, [], text);
    assert.deepEqual(result.problems, [], text);
    assert.equal(result.content, text.trim());
  }
});

test('malformed protocol attempts are reported as problems, never as calls', () => {
  const cases = [
    [block([{ name: 'write_file', arguments: { path: 'a' } }]), /\/content is required/],
    [block([{ name: 'write_file', arguments: { path: 'a', content: 'b', mode: 'x' } }]), /\/mode is not an allowed property/],
    [block([{ name: 'delete_everything', arguments: {} }]), /is not a client tool/],
    [block([{ name: 'read_file', arguments: { path: 'a' } }], 'lgw-stale'), /nonce must be "lgw-testnonce22"/],
    [block([]), /non-empty array/],
    ['```tool_calls\n{"nonce":"' + nonce + '","tool_calls":[{"name":"read_file","arguments":{"path":"a"},}]}\n```', /not valid JSON/],
    [block([{ name: 'read_file', arguments: { path: 'a' } }]) + '\n\nDone!', /anything after/],
    [block([{ name: 'read_file', arguments: { path: 'a' } }]) + '\n\n' + block([{ name: 'read_file', arguments: { path: 'b' } }]), /exactly one tool_calls block/],
    ['```tool_calls\n{"nonce":"' + nonce + '","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}', /not closed/],
    ['{"nonce":"' + nonce + '","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}', /inside a fenced code block/],
    [block([{ name: 'read_file', arguments: 'path=a' }]), /not valid JSON/],
    [block([{ name: 'read_file', arguments: { path: 'a' }, extra: true }]), /unexpected fields/],
  ];
  for (const [text, pattern] of cases) {
    const result = parse(text);
    assert.deepEqual(result.toolCalls, [], text);
    assert(result.problems.some(p => pattern.test(p)), `${pattern} not in ${result.problems.join(' | ')}`);
  }
});

test('a fence whose info string Linear dropped still parses when it carries the nonce', () => {
  const result = parse('```\n' + JSON.stringify({ nonce, tool_calls: [{ name: 'read_file', arguments: { path: 'a' } }] }) + '\n```');
  assert.deepEqual(result.problems, []);
  assert.equal(result.toolCalls[0].name, 'read_file');
  const richRendered = richText({ type: 'doc', content: [{ type: 'code_block', attrs: { language: null }, content: [{ type: 'text', text: JSON.stringify({ nonce, tool_calls: [{ name: 'read_file', arguments: { path: 'b' } }] }) }] }] });
  assert.equal(parse(richRendered).toolCalls[0].arguments.path, 'b');
});

test('tool_choice rules are enforced on the parsed reply', () => {
  const required = normalizeToolChoice('required', tools);
  assert.match(parse('No tools needed.', { choice: required }).problems[0], /must call at least one client tool/);
  const forced = normalizeToolChoice({ type: 'function', function: { name: 'read_file' } }, tools);
  assert.match(parse(block([{ name: 'write_file', arguments: { path: 'a', content: 'b' } }]), { choice: forced }).problems[0], /not allowed for this reply/);
  assert.equal(parse(block([{ name: 'read_file', arguments: { path: 'a' } }]), { choice: forced }).toolCalls.length, 1);
  const none = normalizeToolChoice('none', tools);
  const disabled = parse(block([{ name: 'read_file', arguments: { path: 'a' } }]), { choice: none });
  assert.deepEqual(disabled.toolCalls, []);
  assert.deepEqual(disabled.problems, []);
  const single = parse(block([{ name: 'read_file', arguments: { path: 'a' } }, { name: 'read_file', arguments: { path: 'b' } }]), { parallel: false });
  assert.equal(single.toolCalls.length, 1);
  assert.equal(single.droppedCalls[0].arguments.path, 'b');
});

test('a rendering with valid calls wins when Linear offers rich text and Markdown', () => {
  const valid = block([{ name: 'read_file', arguments: { path: 'a' } }]);
  const result = parseToolReply(['```\n{"broken":\n```', valid], { tools, choice: auto, parallel: true, nonce });
  assert.equal(result.toolCalls.length, 1);
});

test('messages follow the OpenAI tool-loop rules', () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } };
  const ok = normalizeMessages([
    { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'data' }] },
    { role: 'user', content: 'environment details' },
  ]);
  assert.equal(ok.hasToolHistory, true);
  assert.equal(ok.messages[3].name, 'read_file');
  assert.equal(ok.messages[3].content, 'data');
  assert.equal(normalizeMessages([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: 'call_1', content: 'x' }]).messages.at(-1).role, 'tool');
  // SDK-serialized messages often carry explicit nulls for unused fields.
  assert.equal(normalizeMessages([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'hi', tool_calls: null, function_call: null, refusal: null, audio: null }, { role: 'user', content: 'again' }]).messages.length, 3);
  const fail = (messages, pattern) => assert.throws(() => normalizeMessages(messages), e => e.status === 400 && pattern.test(e.message));
  fail([{ role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [call] }, { role: 'user', content: 'skip' }], /Missing: call_1/);
  fail([{ role: 'user', content: 'go' }, { role: 'tool', tool_call_id: 'call_1', content: 'x' }], /must respond to a tool_call_id/);
  fail([{ role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: 'call_1', content: 'x' }, { role: 'tool', tool_call_id: 'call_1', content: 'y' }], /repeats the result/);
  fail([{ role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [call, call] }], /Duplicate tool_call id/);
  fail([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }], /final message/);
  fail([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }], /Only text content/);
  fail([{ role: 'function', name: 'x', content: 'y' }], /role must be/);
  fail([{ role: 'user', content: 'go', tool_calls: [call] }], /only valid on assistant/);
  fail([{ role: 'user', content: 'go', tool_call_id: 'call_1' }], /only valid on tool/);
  fail([{ role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'read_file', arguments: '[1]' } }] }], /encode a JSON object/);
});

test('history hashes tolerate whitespace in assistant text but not changed tool results', () => {
  const base = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'Sure,  I will\nread it.', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path": "a"}' }] }, { role: 'tool', toolCallId: 'call_1', content: 'data' }];
  const same = [base[0], { ...base[1], content: 'Sure, I will read it. ', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }] }, base[2]];
  assert.deepEqual(prefixHashes(base), prefixHashes(same));
  assert.notEqual(prefixHashes(base).at(-1), prefixHashes([base[0], base[1], { ...base[2], content: 'other' }]).at(-1));
  assert.deepEqual(canonicalMessage(base[2]), ['tool', 'call_1', 'data']);
});

test('transcript documents carry client text verbatim in code blocks', () => {
  const tricky = 'line 1\n  * not a list\n# not a heading\n```js\nconst a = `x`;\n```\n_under_ [link](x)';
  const messages = normalizeMessages([{ role: 'user', content: tricky }]).messages;
  const builder = initialDocument({ messages, tools, choice: auto, parallel: true, nonce, format: 'rich', names: new Map() });
  const doc = builder.build();
  const codes = doc.content.filter(n => n.type === 'code_block').map(n => n.content?.[0]?.text);
  assert(codes.includes(tricky));
  assert(doc.content.every(node => node.type !== 'paragraph' || node.content.every(c => c.type === 'hard_break' || c.text)));
  assert(JSON.stringify(doc).includes(nonce));
  const plain = initialDocument({ messages, tools, choice: auto, parallel: true, nonce, format: 'plain', names: new Map() }).build();
  assert.equal(plain.content.length, 1);
  assert(plain.content[0].content[0].text.includes('````text\n' + tricky + '\n````'));
  const delta = continuationDocument({ delta: [{ role: 'tool', toolCallId: 'call_1', content: 'result' }], tools, choice: auto, parallel: true, nonce, format: 'rich', names: new Map([['call_1', 'read_file']]), includeProtocol: false, toolsChanged: false }).build();
  assert(!JSON.stringify(delta).includes('Gateway protocol'));
  assert(JSON.stringify(delta).includes('[tool result for call_1 (read_file), returned by the application]'));
  assert.deepEqual(textDoc('hi'), { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] });
});

test('fence scanner follows CommonMark opening and closing rules', () => {
  const fences = scanFences('a\n````tool_calls\n```\ninside\n````\nb\n~~~\nx');
  assert.equal(fences.length, 2);
  assert.equal(fences[0].info, 'tool_calls');
  assert.equal(fences[0].content, '```\ninside');
  assert.equal(fences[0].closed, true);
  assert.equal(fences[1].closed, false);
  assert.equal(new DocBuilder('rich').code('').build().content[0].content, undefined);
});

test('pattern checks are bounded and the duplicate cache is bounded by entries and bytes', async () => {
  const started = Date.now();
  for (const pattern of ['^(a+)+$', '^(\\w+\\s?)*$', '(x*)*y', '^([a-z]{1,3})+$']) assert.throws(() => compileSchema({ type: 'string', pattern }), /Unsupported JSON Schema/);
  assert(Date.now() - started < 1000, 'no catastrophic backtracking');
  assert.equal(compileSchema({ type: 'string', pattern: '^[a-z]+$' })('abc!').valid, false, 'ordinary patterns still apply');
  assert.equal(compileSchema({ type: 'string', pattern: '^[a-z]+$' })('a'.repeat(20_001) + '!').valid, false, 'very long inputs fail closed');
  assert.throws(() => compileSchema({ type: 'string', pattern: 'x'.repeat(1001) }), /Unsupported JSON Schema/);
  const { ToolSessionStore } = await import('../tool-sessions.mjs');
  const store = new ToolSessionStore(null, { maxCached: 3, maxCachedBytes: 100, maxEntryBytes: 60 });
  store.remember('big', { a: 1 }, 61);
  assert.equal(store.cached('big'), null);
  for (const key of ['a', 'b', 'c']) store.remember(key, { key }, 40);
  assert.equal(store.cached('a'), null, 'oldest entry evicted to stay under the byte budget');
  assert.deepEqual(store.cached('c'), { key: 'c' });
  assert(store.cachedBytes <= 100);
});

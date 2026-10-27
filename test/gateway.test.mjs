import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '../gateway.mjs';
import { LinearClient, GatewayError, richText, currentTurnParts, answerText, htmlDocumentSource, validateRequest, ENDPOINT } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';

const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const part = (turnId, text, phase = 'answer') => ({ id: turnId + ':0', type: 'text', metadata: { turnId, phase }, bodyData: doc(text) });
const valid = { model: 'linear-agent', messages: [{ role: 'user', content: 'hello' }] };
const accepted = { aiConversationSendMessage: { success: true, aiConversation: { id: 'new-conversation' }, assistantMessage: { id: 'new-turn' } } };
const response = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });

test('rich text retains code, links, and list structure', () => {
  const value = richText({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Linear', marks: [{ type: 'link', attrs: { href: 'https://linear.app' } }] }] },
    { type: 'code_block', attrs: { language: 'js' }, content: [{ type: 'text', text: 'console.log(1)' }] },
    { type: 'bullet_list', content: [{ type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
  ] });
  assert.equal(value, '[Linear](https://linear.app)\n\n```js\nconsole.log(1)\n```\n\n- one');
});

test('only the requested assistant turn and final answer are returned', () => {
  const parts = currentTurnParts({ parts: [part('old-turn', 'OLD'), part('new-turn', 'thinking', 'commentary'), { ...part('new-turn', 'NEW'), id: 'new-turn:1' }] }, 'new-turn');
  assert.equal(answerText(parts), 'NEW');
});

test('bare HTML source survives Markdown list parsing and nested code blocks without adding JS fences', () => {
  const text = value => ({ type: 'text', text: value });
  const paragraph = (...content) => ({ type: 'paragraph', content });
  const bodyData = { type: 'doc', content: [
    paragraph(text('<!DOCTYPE html>\n<html><head><style>')),
    { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph(text('{box-sizing:border-box;}'))] }] },
    paragraph(text('</style></head><body><svg></svg><script>\nlet x=1;')),
    { type: 'code_block', content: [text('const path = `M${x} 0`;')] },
    paragraph(text('const value = '), { ...text('rotate(1)'), marks: [{ type: 'code' }] }, text(';\n</script></body></html>')),
  ] };
  const html = htmlDocumentSource(bodyData);
  assert.match(html, /\* \{box-sizing/);
  assert(!html.includes('```'));
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
  const rendered = answerText([{ type: 'text', bodyData }]);
  assert.equal(rendered.match(/```/g).length, 2);
  assert.match(rendered, /^```html/);
  assert.equal(htmlDocumentSource(doc('Here is an HTML example: <html></html>')), null);
  assert.equal(richText({ type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph(text('normal list'))] }] }), '- normal list');
});

test('request validation rejects unsupported capabilities and duplicate native history', () => {
  assert.equal(validateRequest(valid).text, 'hello');
  assert.equal(validateRequest({ ...valid, tools: [], tool_choice: 'auto' }).text, 'hello');
  assert.throws(() => validateRequest({ ...valid, model: 'claude-opus' }), error => error.code === 'unsupported_model');
  assert.throws(() => validateRequest({ ...valid, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.org/a.png' } }] }] }), /Only text/);
  assert.throws(() => validateRequest({ ...valid, conversation_id: 'e1586bc3-4b49-4782-8d76-774027bcea82', messages: [...valid.messages, ...valid.messages] }), /only the new user message/);
  const history = validateRequest({ ...valid, messages: [{ role: 'system', content: 'be concise' }, ...valid.messages] });
  assert.match(history.text, /\[system\]\nbe concise/);
});

test('polling does not accept an old completed response or retry the send mutation', async () => {
  const calls = [];
  let reads = 0;
  const client = new LinearClient({ headers: { cookie: 'test-only' } }, { pollMs: 0, fetchImpl: async (url, options) => {
    assert.equal(url, ENDPOINT);
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.query.startsWith('mutation AiConversationSendMessage')) return response(accepted);
    reads++;
    return response({ aiConversation: { status: 'complete', parts: reads === 1 ? [part('old-turn', 'OLD')] : [part('old-turn', 'OLD'), part('new-turn', 'NEW')] } });
  } });
  const result = await client.chat({ text: 'hello', requestedModel: 'openai/gpt-6.1-sol' }, AbortSignal.timeout(2000));
  assert.deepEqual(result, { text: 'NEW', conversationId: 'new-conversation' });
  assert.equal(calls.filter(c => c.query.startsWith('mutation')).length, 1);
  assert.equal(calls[0].variables.input.model, 'openai/gpt-6.1-sol');
  assert.equal(reads, 2);
});

test('reasoning choices validate without rewriting the user prompt', () => {
  for (const effort of ['low', 'medium', 'high']) {
    const input = validateRequest({ ...valid, reasoning_effort: effort });
    assert.equal(input.reasoningEffort, effort);
    assert.equal(input.text, valid.messages[0].content);
  }
  for (const value of [undefined, null, 'auto']) assert.equal(validateRequest({ ...valid, reasoning_effort: value }).reasoningEffort, undefined);
  for (const value of ['xhigh', 'invalid', 4, {}, []]) assert.throws(() => validateRequest({ ...valid, reasoning_effort: value }), error => error.code === 'invalid_reasoning_effort');
});

test('reasoning effort is sent as an upstream field and defaults remain omitted', async () => {
  for (const effort of [undefined, 'low', 'medium', 'high']) {
    let sent;
    const client = new LinearClient({ headers: {} }, { pollMs: 0, fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      if (request.query.startsWith('mutation AiConversationSendMessage')) { sent = request.variables.input; return response(accepted); }
      return response({ aiConversation: { status: 'complete', parts: [part('new-turn', 'OK')] } });
    } });
    await client.chat({ text: 'hello', reasoningEffort: effort }, AbortSignal.timeout(2000));
    assert.equal(sent.reasoningEffort, effort);
    assert.equal(Object.hasOwn(sent, 'reasoningEffort'), effort !== undefined);
    assert.equal(sent.bodyData.content[0].content[0].text, 'hello');
  }
});

test('aborting an accepted chat cancels it upstream', async () => {
  const controller = new AbortController();
  let cancels = 0;
  const client = new LinearClient({ headers: {} }, { pollMs: 0, fetchImpl: async (url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.startsWith('mutation AiConversationSendMessage')) return response(accepted);
    if (query.startsWith('mutation AiConversationCancel')) { cancels++; return response({ aiConversationCancel: { success: true } }); }
    controller.abort(new GatewayError(504, 'timeout', 'test timeout'));
    return response({ aiConversation: { status: 'active', parts: [] } });
  } });
  await assert.rejects(client.chat({ text: 'hello' }, controller.signal), /test timeout|aborted/);
  assert.equal(cancels, 1);
});

test('authentication errors do not expose upstream cookies or arbitrary error text', async () => {
  const client = new LinearClient({ headers: { cookie: 'SECRET' } }, { fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: 'SECRET', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), { status: 400 }) });
  await assert.rejects(client.call('query X { viewer { id } }', {}), error => error.code === 'linear_session_expired' && !error.message.includes('SECRET'));
});

async function withGateway(fn, options = {}) {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const requestedModels = [];
  const server = createGateway({ apiKey: 'test-key', timeoutMs: 2000, clientFactory: () => ({ chat: async (input, signal, onAccepted) => {
    calls++;
    requestedModels.push(input.requestedModel);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await onAccepted('e1586bc3-4b49-4782-8d76-774027bcea82');
    await sleep(5, undefined, { signal });
    active--;
    return { text: input.text, conversationId: 'e1586bc3-4b49-4782-8d76-774027bcea82' };
  } }), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body, key = 'test-key') => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try { await fn({ base, request, stats: () => ({ calls, maximumActive, requestedModels }) }); }
  finally { await server.shutdown(); }
}

test('local HTTP API requires its own key, returns JSON, and serializes requests', () => withGateway(async ({ base, request, stats }) => {
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await request(valid, 'wrong-key')).status, 401);
  assert.equal(stats().calls, 0);
  const replies = await Promise.all([request(valid), request(valid)]);
  for (const reply of replies) {
    const body = await reply.json();
    assert.equal(body.choices[0].message.content, 'hello');
    assert.equal(body.model, 'linear-agent');
    assert.equal(body.usage, null);
    assert.equal(reply.headers.get('x-linear-conversation-id'), body.conversation_id);
  }
  assert.equal(stats().maximumActive, 1);
}));

test('SSE has a role, final content, stop, unknown usage, and DONE', () => withGateway(async ({ request }) => {
  const reply = await request({ ...valid, stream: true, stream_options: { include_usage: true } });
  assert.equal(reply.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = (await reply.text()).split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map(JSON.parse);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[1].choices[0].delta.content, 'hello');
  assert.equal(chunks[2].choices[0].finish_reason, 'stop');
  assert.equal(chunks[3].usage, null);
}));

test('model catalog enables only candidates that accepted a request and returned a reply', () => {
  const catalog = modelEntries({ tests: [
    { requested_model: 'openai/gpt-6.1-sol', request_accepted: true, reply_received: true },
    { requested_model: 'anthropic/claude-opus-5-5', request_accepted: true, reply_received: false },
    { requested_model: 'unknown/model', request_accepted: true, reply_received: true },
  ] });
  assert.deepEqual(catalog.map(m => m.id), ['linear-agent', 'openai/gpt-6.1-sol']);
  assert(catalog.every(m => m.selection_verified === false));
});

test('new Claude entries require successful evidence and retain unverified model identity', () => {
  const ids = ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-fable-5', 'anthropic/claude-fable-5-1'];
  const attempts = ids.map(requested_model => ({ requested_model, request_accepted: true, reply_received: false }));
  assert.deepEqual(modelEntries({ tests: attempts }).map(m => m.id), ['linear-agent']);
  const catalog = modelEntries({ tests: attempts.map(t => ({ ...t, reply_received: true })) });
  assert.deepEqual(catalog.slice(1).map(m => m.id), ids);
  assert(catalog.slice(1).every(m => m.selection_verified === false && m.test_status === 'reply_received'));
});

test('browser landing page opens without a key while the chat API remains authenticated', () => withGateway(async ({ base, request }) => {
  for (const path of ['/', '/v1', '/v1/']) {
    const page = await fetch(base + path);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /Linear Agent 本地网关/);
    assert(!html.includes('test-key'));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script));
  }
  assert.equal((await request(valid, '')).status, 401);
}));

test('model selection is forwarded and does not claim a verified model identity', () => withGateway(async ({ base, request, stats }) => {
  const response = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer test-key' } });
  assert.deepEqual((await response.json()).data.map(m => m.id), ['linear-agent', 'openai/gpt-6.1-sol']);
  const reply = await request({ ...valid, model: 'openai/gpt-6.1-sol' });
  const data = await reply.json();
  assert.equal(reply.status, 200);
  assert.equal(data.requested_model, 'openai/gpt-6.1-sol');
  assert.equal(data.model, 'linear-agent');
  assert.equal(data.model_selection_verified, false);
  assert.equal(reply.headers.get('x-linear-requested-model'), 'openai/gpt-6.1-sol');
  assert.deepEqual(stats().requestedModels, ['openai/gpt-6.1-sol']);
}, { modelsProvider: async () => modelEntries({ tests: [{ requested_model: 'openai/gpt-6.1-sol', request_accepted: true, reply_received: true }] }) }));

const cherryTools = ['fs_read', 'web_fetch', 'web_search'].map(name => ({ type: 'function', function: { name, description: 'CLIENT_ONLY_TOOL_DESCRIPTION', parameters: { type: 'object', properties: {} } } }));
const cherryHtmlRequest = {
  model: 'linear-agent',
  messages: [
    { role: 'system', content: '<citations>Only cite supplied tool results.</citations>' },
    { role: 'user', content: '不看其他工作区。创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画' },
    { role: 'assistant', content: '...', reasoning_content: '' },
    { role: 'user', content: '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画' },
  ],
  tools: cherryTools,
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true },
};

test('Cherry optional tools allow direct HTML generation without pretending client tools were executed', () => {
  for (const choice of ['auto', 'none', undefined]) {
    const input = validateRequest({ ...cherryHtmlRequest, tool_choice: choice });
    assert.match(input.text, /鹈鹕骑自行车/);
    assert.match(input.text, /外部工具未连接/);
    assert(!input.text.includes('CLIENT_ONLY_TOOL_DESCRIPTION'));
    assert(!input.text.includes('fs_read'));
    assert.equal(input.compatibility.client_tools, 'unavailable');
    assert.equal(input.compatibility.ignored_tool_definitions, 3);
  }
  assert.equal(validateRequest({ ...valid, tool_choice: 'none' }).compatibility, undefined);
});

test('required or named client tools and tool-result history remain explicit errors', () => {
  for (const choice of ['required', { type: 'function', function: { name: 'fs_read' } }]) {
    assert.throws(() => validateRequest({ ...valid, tools: cherryTools, tool_choice: choice }), e => e.status === 400 && e.code === 'client_tools_unavailable');
  }
  assert.throws(() => validateRequest({ ...valid, tool_choice: 'invalid' }), e => e.code === 'invalid_tool_choice');
  assert.throws(() => validateRequest({ ...valid, tools: 'not an array' }), e => e.code === 'invalid_tools');
  assert.throws(() => validateRequest({ ...valid, tools: [{ type: 'function', function: {} }] }), e => e.code === 'invalid_tools');
  assert.throws(() => validateRequest({ ...valid, messages: [{ role: 'tool', tool_call_id: 'call-1', content: 'result' }, ...valid.messages] }), e => e.code === 'unsupported_message');
  assert.throws(() => validateRequest({ ...valid, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1' }] }, ...valid.messages] }), e => e.code === 'unsupported_message');
});

test('Cherry request completes with valid SSE and exposes text-only compatibility metadata', () => withGateway(async ({ request, stats }) => {
  const reply = await request(cherryHtmlRequest);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('x-linear-client-tools'), 'unavailable; text-only');
  const events = (await reply.text()).split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map(JSON.parse);
  assert(chunks.every(c => c.compatibility.client_tools === 'unavailable'));
  assert(chunks.some(c => c.choices?.some(choice => choice.finish_reason === 'stop')));
  assert(!chunks.some(c => c.choices?.some(choice => choice.delta?.tool_calls)));
  assert.equal(stats().calls, 1);
  const denied = await request({ ...cherryHtmlRequest, tool_choice: 'required' });
  assert.equal(denied.status, 400);
  assert.equal(stats().calls, 1);
}));

test('JSON and Cherry SSE return the requested effort with no claim about the actual compute budget', () => withGateway(async ({ base, request, stats }) => {
  const reply = await request({ ...valid, reasoning_effort: 'high' });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('x-linear-requested-reasoning-effort'), 'high');
  const json = await reply.json();
  assert.equal(json.requested_reasoning_effort, 'high');
  assert.equal(json.reasoning_effort_verified, false);
  const stream = await request({ ...cherryHtmlRequest, reasoning_effort: 'low' });
  assert.equal(stream.status, 200);
  const chunks = (await stream.text()).split('\n\n').filter(e => e.startsWith('data: ') && !e.includes('[DONE]')).map(e => JSON.parse(e.slice(6)));
  assert(chunks.every(c => c.requested_reasoning_effort === 'low' && c.reasoning_effort_verified === false));
  const count = stats().calls;
  assert.equal((await request({ ...valid, reasoning_effort: 'xhigh' })).status, 400);
  assert.equal(stats().calls, count);
  const catalog = await (await fetch(base + '/v1/models', { headers: { authorization: 'Bearer test-key' } })).json();
  assert.deepEqual(catalog.data[0].supported_reasoning_efforts, ['auto', 'low', 'medium', 'high']);
  assert.equal(catalog.data[0].default_reasoning_effort, 'auto');
  assert.equal(catalog.object, 'list');
}, { modelsProvider: async () => modelEntries() }));

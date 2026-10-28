import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProgressiveText } from '../progressive.mjs';
import { createGateway } from '../gateway.mjs';
import { MockLinear, markdownToDoc } from './mock-linear.mjs';
import { client, parseSse } from './openai-client.mjs';

const textPart = (markdown, ended = false, id = 'turn:0') => ({ id, type: 'text', metadata: { turnId: 'turn', phase: 'answer', ...(ended ? { endedAt: 'end' } : {}) }, bodyData: markdownToDoc(markdown) });

test('only blocks that can no longer change are emitted, with separators sent before the next block', () => {
  const stream = new ProgressiveText();
  assert.equal(stream.update([textPart('First paragraph, still being writ')]), '');
  assert.equal(stream.update([textPart('First paragraph, still being written.\n\nSecond')]), 'First paragraph, still being written.');
  assert.equal(stream.update([textPart('First paragraph, still being written.\n\nSecond one.\n\n- item')]), '\n\nSecond one.');
  const final = 'First paragraph, still being written.\n\nSecond one.\n\n- item\n- item two';
  assert.equal(stream.finish(final), '\n\n- item\n- item two');
  assert.equal(stream.emitted, final);
  assert.equal(stream.progressiveChunks, 2);
  assert.equal(stream.divergent, false);
});

test('a growing HTML document is held until complete, and tool mode stops before code blocks', () => {
  const html = new ProgressiveText();
  assert.equal(html.update([textPart('<!doctype html>\n<html><head>\n\n* {box-sizing: border-box}\n\nmore')]), '');
  const code = new ProgressiveText({ stopAtCode: true });
  assert.equal(code.update([textPart('Plan first.\n\nThen act.\n\n```tool_calls\n{"nonce":"x"')]), 'Plan first.\n\nThen act.');
  assert.equal(code.update([textPart('Plan first.\n\nThen act.\n\n```tool_calls\n{"nonce":"x","tool_calls":[]}\n```\n\ntrailing')]), '');
  const unfenced = new ProgressiveText({ stopAtCode: true });
  assert.equal(unfenced.update([textPart('Intro.\n\n{"nonce":"lgw-x","tool_calls":[]}\n\nmore')]), 'Intro.');
  const earlier = new ProgressiveText();
  assert.equal(earlier.update([textPart('Done part.', true, 'turn:0'), textPart('Next part grow', false, 'turn:1')]), 'Done part.');
});

test('if Linear rewrites text that was already sent, the stream fails without duplicating the final text', () => {
  const stream = new ProgressiveText();
  stream.update([textPart('Hello wrld.\n\nSecond')]);
  assert.throws(() => stream.finish('Hello world.\n\nSecond paragraph.'), e => e.code === 'linear_stream_rewritten');
  assert.equal(stream.divergent, true);
  assert.equal(stream.emitted, 'Hello wrld.');
});

async function setup(t, model, gateway = {}) {
  const upstream = new MockLinear({ model });
  const server = createGateway({ apiKey: 'test-key', timeoutMs: 5000, clientFactory: () => upstream.client(), ...gateway });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  return { upstream, ...client(`http://127.0.0.1:${server.address().port}`) };
}
const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1}: ` + 'word '.repeat(30).trim() + '.').join('\n\n');
const ask = extra => ({ model: 'linear-agent', messages: [{ role: 'user', content: 'write five paragraphs' }], ...extra });

test('SSE forwards text while Linear is still generating and the result equals the JSON reply', async t => {
  const { complete } = await setup(t, () => ({ markdown: paragraphs, chunks: 6, commentary: 'INTERNAL PLANNING NOTES' }));
  const streamed = await complete(ask({ stream: true }));
  const contentChunks = streamed.chunks.filter(c => c.choices?.[0]?.delta?.content);
  assert(contentChunks.length >= 3, 'several content deltas arrive before the reply is complete');
  assert.equal(streamed.message.content, paragraphs);
  const finish = streamed.chunks.find(c => c.choices?.[0]?.finish_reason === 'stop');
  assert(finish.streaming.progressive_chunks >= 2);
  assert.equal(finish.streaming.rewritten, false);
  const json = await complete(ask());
  assert.equal(json.message.content, paragraphs);
  assert(!JSON.stringify(streamed.chunks).includes('INTERNAL PLANNING NOTES'), 'commentary/reasoning parts are never streamed');
});

test('an upstream that publishes only the final reply produces one content delta, without artificial splitting', async t => {
  const { complete } = await setup(t, () => ({ markdown: paragraphs, chunks: 1 }));
  const streamed = await complete(ask({ stream: true }));
  const contentChunks = streamed.chunks.filter(c => c.choices?.[0]?.delta?.content);
  assert.equal(contentChunks.length, 1);
  assert.equal(contentChunks[0].choices[0].delta.content, paragraphs);
  assert.equal(streamed.chunks.find(c => c.choices?.[0]?.finish_reason).streaming.progressive_chunks, 0);
});

test('LINEAR_STREAM_MODE=buffered keeps the original single-chunk SSE', async t => {
  const { complete } = await setup(t, () => ({ markdown: paragraphs, chunks: 6 }), { chat: { streamMode: 'buffered' } });
  const streamed = await complete(ask({ stream: true }));
  assert.equal(streamed.chunks.filter(c => c.choices?.[0]?.delta?.content).length, 1);
  assert.equal(streamed.chunks.find(c => c.choices?.[0]?.finish_reason).streaming, undefined);
});

test('disconnecting during a stream cancels the Linear turn', async t => {
  const { post, upstream } = await setup(t, () => ({ markdown: paragraphs, chunks: 6, waitPolls: 1e9 }));
  const controller = new AbortController();
  const response = await post(ask({ stream: true }), { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"role":"assistant"/);
  controller.abort();
  for (let i = 0; i < 100 && !upstream.cancels.length; i++) await sleep(10);
  assert.equal(upstream.cancels.length, 1);
});

test('an empty completed turn fails clearly instead of waiting for the timeout', async t => {
  const { complete } = await setup(t, () => ({ markdown: '' }));
  const started = Date.now();
  const result = await complete(ask());
  assert.equal(result.response.status, 502);
  assert.equal(result.error.error.code, 'linear_empty_reply');
  assert(Date.now() - started < 2000);
  const sse = parseSse(await (await (await setup(t, () => ({ markdown: '' }))).post(ask({ stream: true }))).text());
  assert.equal(sse.chunks.at(-1).error.code, 'linear_empty_reply');
});

test('Linear cloud tools only trigger the local-file notice when the reply is about files', async t => {
  const { complete } = await setup(t, ({ sendIndex }) => sendIndex === 0
    ? { markdown: 'The square root of 2 is 1.414.', internalTools: ['Bash'] }
    : { markdown: 'I created index.html in /workspace.', internalTools: ['CreateSandbox'] });
  const math = await complete(ask());
  assert.equal(math.message.content, 'The square root of 2 is 1.414.');
  assert.deepEqual(math.json.linear_internal_tool_calls, ['Bash']);
  const file = await complete(ask());
  assert.match(file.message.content, /\[网关提示\]/);
});

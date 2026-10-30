import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '../gateway.mjs';
import { detailedReadState } from '../upstream.mjs';
import { promptFormatState } from '../chat-completions.mjs';
import { contentSkeleton, htmlRichEquivalent, skeleton, sameContent, spliceRest } from '../consistency.mjs';
import { LiveText, holdTrailing, htmlStart, liveForm, verifyPart } from '../progressive.mjs';
import { RealtimeChannel, TurnStream, createTiming, isLinearRealtimeUrl, realtimeIdentity } from '../realtime.mjs';
import { readConfig } from '../config.mjs';
import { MockLinear, markdownToDoc, nonceOf, toolCallBlock } from './mock-linear.mjs';
import { MockSync, autoSteps } from './mock-sync.mjs';
import { client, parseSse } from './openai-client.mjs';

const identity = { useraccount: 'mock-account', 'linear-client-version': '99999', 'linear-client-database-id': 'db-1', 'user-agent': 'MockAgent/1.0' };

// `releaseAfter` completes a held turn on GraphQL after a fixed time, independent of the socket.
async function setup(t, model, { sync: syncOptions = {}, realtime = {}, headers = identity, gateway = {}, mock = {}, releaseAfter = null } = {}) {
  detailedReadState.reset();
  promptFormatState.reset();
  const holder = {};
  const upstream = holder.upstream = new MockLinear({ model, ...(releaseAfter ? { onSend: record => setTimeout(() => holder.upstream.release(record.turnId), releaseAfter) } : {}), ...mock });
  const sync = await new MockSync({ upstream, ...syncOptions }).listen();
  const factory = realtime === null ? null : sync.factory(realtime);
  const server = createGateway({ apiKey: 'test-key', timeoutMs: 5000, clientFactory: () => upstream.client({ realtime: factory, headers }), ...gateway });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await server.shutdown(); await sync.close(); });
  return { upstream, sync, server, ...client(`http://127.0.0.1:${server.address().port}`) };
}
const ask = (content = 'hello', extra = {}) => ({ model: 'linear-agent', stream: true, messages: [{ role: 'user', content }], ...extra });
const deltas = result => result.chunks.filter(c => typeof c.choices?.[0]?.delta?.content === 'string').map(c => c.choices[0].delta.content);
const finished = result => result.chunks.find(c => c.choices?.[0]?.finish_reason);
const waitFor = async (check, ms = 2000) => { for (let i = 0; i < ms / 10 && !check(); i++) await sleep(10); return check(); };
const LONG = '# Plan\n\nThe first paragraph explains the idea in some detail, with **bold** text.\n\n1. Step one\n2. Step two\n\n```js\nconsole.log("hi")\n```\n\nThat is all.';
const ANSWER = (markdown, extra = {}) => () => ({ markdown, hold: true, realtime: 'auto', ...extra });

test('realtime deltas reach the client before Linear GraphQL has any answer text, and the final text is exact', async t => {
  const { complete, upstream, sync } = await setup(t, ANSWER(LONG));
  const result = await complete(ask());
  assert.equal(result.message.content, LONG);
  const chunks = deltas(result);
  assert(chunks.length >= 4, 'several real deltas are forwarded');
  assert.equal(chunks.join(''), LONG);
  const final = finished(result);
  assert.equal(final.streaming.source, 'realtime');
  assert.equal(final.streaming.consistency, 'exact');
  assert.equal(final.streaming.rewritten, false);
  assert.equal(final.streaming.realtime.status, 'streamed');
  assert(final.timings.first_text_ms <= final.timings.upstream_complete_ms, 'first text is earlier than GraphQL completion');
  assert(Number.isInteger(final.timings.send_ack_ms) && Number.isInteger(final.timings.first_stream_event_ms));
  assert.equal(upstream.sends.length, 1, 'the message is sent once');
  // Handshake and subscription exactly as Linear's web client; the cookie goes only in the upgrade.
  const [connection] = sync.connections;
  assert.equal(connection.headers.cookie, 'MOCK_ONLY_COOKIE');
  assert.equal(connection.headers.origin, 'https://linear.app');
  assert.equal(connection.headers['user-agent'], 'MockAgent/1.0');
  assert.equal(connection.url.searchParams.get('userId'), 'mock-user');
  assert.equal(connection.url.searchParams.get('userAccountId'), 'mock-account');
  const [hshk, subscribe] = connection.commands;
  assert.deepEqual(hshk, { cmd: 'hshk', userId: 'mock-user', userAccountId: 'mock-account', clientType: 'web', clientDatabaseId: 'db-1', protocolVersion: 3, clientVersion: '99999', useBinaryProtocol: false, supportsSpectatorMode: true });
  assert.deepEqual(subscribe, { cmd: 'streamData', action: 'subscribe', modelName: 'AiConversation', modelId: upstream.sends[0].conversationId, propertyName: 'parts' });
  assert(await waitFor(() => sync.open === 0), 'the socket is released after the reply');
  assert(connection.commands.some(c => c.action === 'unsubscribe'));
  assert(!JSON.stringify(result.chunks).includes('SECRET'), 'reasoning is never forwarded');
});

test('a short greeting streams through the realtime channel too', async t => {
  const { complete } = await setup(t, ANSWER('Hi there! How can I help?', { realtime: ({ helpers }) => helpers.autoSteps({ deltas: 3 }) }));
  const result = await complete(ask('hi'));
  assert.equal(result.message.content, 'Hi there! How can I help?');
  assert.equal(finished(result).streaming.source, 'realtime');
  assert(deltas(result).length >= 2);
});

test('JSON requests and buffered streaming never open a realtime socket', async t => {
  const { complete, sync } = await setup(t, () => ({ markdown: 'Plain reply.', chunks: 2 }));
  const json = await complete({ model: 'linear-agent', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(json.message.content, 'Plain reply.');
  assert(Number.isInteger(json.json.timings.send_ack_ms));
  assert.equal(sync.connections.length, 0);
  const buffered = await setup(t, () => ({ markdown: 'Plain reply.', chunks: 2 }), { gateway: { chat: { streamMode: 'buffered' } } });
  const streamed = await buffered.complete(ask());
  assert.equal(streamed.message.content, 'Plain reply.');
  assert.equal(buffered.sync.connections.length, 0);
});

test('with realtime off the gateway polls exactly as before', async t => {
  const paragraphs = 'One paragraph here.\n\nTwo paragraph here.\n\nThree paragraph here.';
  const { complete, sync } = await setup(t, () => ({ markdown: paragraphs, chunks: 4 }), { realtime: null });
  const result = await complete(ask());
  assert.equal(result.message.content, paragraphs);
  assert.equal(sync.connections.length, 0);
  const final = finished(result);
  assert.equal(final.streaming.source, 'polling');
  assert.equal(final.streaming.realtime, undefined);
  assert(final.streaming.progressive_chunks >= 1);
  // The production default is also off when createGateway is not given a realtime config.
  const plain = new MockLinear({ model: () => ({ markdown: 'x' }) });
  assert.equal(plain.client().realtime, null);
});

test('a disconnect mid-stream falls back to polling the same turn without resending or duplicating text', async t => {
  const { complete, upstream } = await setup(t, ANSWER(LONG, { realtime: ({ helpers }) => [...helpers.autoSteps({ deltas: 10, release: false, reasoning: false }).slice(0, 9), { delay: 20 }, { drop: true }] }), { releaseAfter: 300 });
  const result = await complete(ask());
  assert.equal(result.message.content, LONG);
  const final = finished(result);
  assert.equal(final.streaming.source, 'realtime');
  // Native WebSocket may report an error before close for an abrupt disconnect.
  assert.match(final.streaming.realtime.fallback_reason, /^(?:disconnected|socket_error)$/);
  assert(deltas(result).length >= 2, 'text before the disconnect was already streamed');
  assert.equal(upstream.sends.length, 1, 'the accepted message is never resent');
  assert.equal(upstream.cancels.length, 0);
});

test('after a disconnect the remainder is spliced onto raw Markdown that Linear normalized differently', async t => {
  const raw = 'Intro line.\n\n* alpha item\n* beta item\n* gamma item';
  const normalized = 'Intro line.\n\n- alpha item\n- beta item\n- gamma item';
  const { complete } = await setup(t, () => ({
    markdown: normalized, hold: true,
    realtime: ({ helpers }) => [...helpers.autoSteps({ text: raw, deltas: 6, release: false, reasoning: false }).slice(0, 7), { delay: 20 }, { drop: true }],
  }), { releaseAfter: 300 });
  const result = await complete(ask());
  const content = result.message.content;
  assert(content.startsWith('Intro line.\n\n* alpha item'), 'the streamed raw prefix is kept');
  assert.equal(skeleton(content), skeleton(normalized), 'no word is repeated or lost');
  for (const word of ['alpha', 'beta', 'gamma']) assert.equal(content.split(word).length, 2);
  assert.equal(finished(result).streaming.consistency, 'spliced');
});

test('noauth, a silent handshake and a rejected upgrade fall back to polling without delaying the send', async t => {
  for (const [options, reason] of [[{ sync: { handshake: 'noauth' } }, 'noauth'], [{ sync: { handshake: 'none' }, realtime: { connectTimeoutMs: 150 } }, 'connect_timeout'], [{ sync: { upgrade: false } }, null], [{ sync: { handshake: 'no_sync' } }, 'handshake_rejected']]) {
    // The turn completes on GraphQL only after the socket had time to fail.
    const { complete, upstream, sync } = await setup(t, () => ({ markdown: 'Fallback reply text.', hold: true }), { ...options, releaseAfter: 300 });
    const result = await complete(ask());
    assert.equal(result.message.content, 'Fallback reply text.');
    const final = finished(result);
    assert.equal(final.streaming.realtime.status, 'fallback');
    if (reason) assert.equal(final.streaming.realtime.fallback_reason, reason);
    else assert.match(final.streaming.realtime.fallback_reason, /^(?:connect_failed|closed_before_ready)$/);
    assert(final.timings.send_ack_ms < 150, 'the GraphQL send does not wait for the socket');
    assert.equal(upstream.sends.length, 1);
    assert(!sync.connections.some(c => c.subscriptions.length), 'nothing was subscribed');
    assert(await waitFor(() => sync.open === 0));
  }
});

test('accounts without realtime identity never open a socket; a configured client version is used when the header is missing', async t => {
  const missing = await setup(t, () => ({ markdown: 'No identity.' }), { headers: { 'linear-client-version': '1' } });
  const result = await missing.complete(ask());
  assert.equal(result.message.content, 'No identity.');
  assert.equal(finished(result).streaming.realtime.fallback_reason, 'missing_user_account');
  assert.equal(missing.sync.connections.length, 0);
  const noVersion = await setup(t, () => ({ markdown: 'No version.' }), { headers: { useraccount: 'acc' } });
  assert.equal(finished(await noVersion.complete(ask())).streaming.realtime.fallback_reason, 'missing_client_version');
  assert.equal(noVersion.sync.connections.length, 0);
  const fallback = await setup(t, ANSWER('Configured version.'), { headers: { useraccount: 'acc' }, realtime: { clientVersion: '12345' } });
  assert.equal((await fallback.complete(ask())).message.content, 'Configured version.');
  assert.equal(fallback.sync.connections[0].commands[0].clientVersion, '12345');
  assert.equal(fallback.sync.connections[0].commands[0].clientDatabaseId, undefined);
});

test('duplicate and out-of-order messages (same cursor) are applied once', async t => {
  const text = 'Repeated deltas must not repeat words in the reply.';
  const { complete } = await setup(t, ANSWER(text, {
    realtime: ({ helpers }) => {
      const steps = helpers.autoSteps({ deltas: 5, reasoning: false });
      const doubled = steps.flatMap(step => step.message?.data?.type === 'textDelta' ? [step, step] : [step]);
      const stale = steps.find(step => step.message?.data?.type === 'textDelta');
      doubled.splice(doubled.length - 2, 0, stale);
      return doubled;
    },
  }));
  const result = await complete(ask());
  assert.equal(result.message.content, text);
  const realtime = finished(result).streaming.realtime;
  assert(realtime.duplicates >= 6, 'resent and older cursors are dropped');
  assert.equal(finished(result).streaming.consistency, 'exact');
});

test('equal-length deltas sharing a cursor are streamed intact and exact duplicates are ignored', async t => {
  const text = 'abcdef';
  const { complete } = await setup(t, () => ({
    markdown: text, hold: true,
    realtime: ({ turn }) => {
      const id = turn.id + ':0', meta = { phase: 'answer', turnId: turn.id };
      const delta = value => ({ cmd: 'streamData', cursor: 2, data: { type: 'textDelta', id, delta: value } });
      return [
        { message: { cmd: 'streamData', cursor: 1, data: { type: 'text', id, bodyData: { type: 'doc', content: [] }, status: 'inProgress', metadata: meta } } },
        { message: delta('abc') }, { delay: 30 }, { message: delta('def') },
        { message: delta('def') }, { delay: 30 },
        { message: { cmd: 'streamData', cursor: 3, data: { type: 'text', id, bodyData: markdownToDoc(text), status: 'complete', metadata: meta } } },
        { release: true },
      ];
    },
  }));
  const result = await complete(ask());
  assert.equal(result.message.content, text);
  assert.equal(finished(result).streaming.consistency, 'exact');
  assert.equal(finished(result).streaming.realtime.duplicates, 1);
});

test('a conversation subscription ignores other conversations, old turns, commentary and reasoning', async t => {
  const text = 'Only this answer belongs to the current turn.';
  const { complete, sync, upstream } = await setup(t, ANSWER(text, {
    realtime: ({ turn, helpers }) => [
      { message: { cmd: 'streamData', modelName: 'AiConversation', modelId: 'other-conversation', propertyName: 'parts', data: { type: 'text', id: 'x:0', bodyData: markdownToDoc('LEAK OTHER CONVERSATION'), metadata: { phase: 'answer', turnId: 'x' } } } },
      { message: { cmd: 'streamData', modelName: 'AiConversationTurn', modelId: turn.id, propertyName: 'parts', data: { type: 'textDelta', id: turn.id + ':0', delta: 'LEAK WRONG MODEL' } } },
      { message: { cmd: 'streamData', data: { type: 'text', id: 'old-turn:0', bodyData: { type: 'doc', content: [] }, status: 'inProgress', metadata: { phase: 'answer', turnId: 'old-turn' } } } },
      { message: { cmd: 'streamData', data: { type: 'textDelta', id: 'old-turn:0', delta: 'LEAK OLD TURN' } } },
      { message: { cmd: 'streamData', data: { type: 'text', id: turn.id + ':c', bodyData: { type: 'doc', content: [] }, status: 'inProgress', metadata: { phase: 'commentary', turnId: turn.id } } } },
      { message: { cmd: 'streamData', data: { type: 'textDelta', id: turn.id + ':c', delta: 'LEAK COMMENTARY' } } },
      ...helpers.autoSteps({ deltas: 4 }),
    ],
  }), { realtime: { subscription: 'conversation' } });
  const result = await complete(ask());
  assert.equal(result.message.content, text);
  assert(!/LEAK|SECRET/.test(JSON.stringify(result.chunks)));
  const realtime = finished(result).streaming.realtime;
  assert.equal(realtime.subscription, 'conversation');
  assert(realtime.foreign_parts >= 1 && realtime.commentary_parts >= 1);
  const subscribe = sync.connections[0].commands[1];
  assert.equal(subscribe.modelName, 'AiConversation');
  assert.equal(subscribe.modelId, upstream.sends[0].conversationId);
});

test('cancelling mid-stream cancels the Linear turn and releases the socket', async t => {
  const { post, upstream, sync } = await setup(t, ANSWER(LONG, { realtime: ({ helpers }) => [...helpers.autoSteps({ deltas: 10, release: false, reasoning: false }).slice(0, 5), { delay: 3000 }] }));
  const controller = new AbortController();
  const response = await post(ask(), { signal: controller.signal });
  const reader = response.body.getReader();
  let seen = '';
  while (!/"content":"/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert(await waitFor(() => upstream.cancels.length === 1), 'the Linear turn is cancelled');
  assert(await waitFor(() => sync.open === 0), 'the socket is closed');
  assert(sync.connections[0].commands.some(c => c.action === 'unsubscribe'));
});

test('an HTML document streams inside an html fence and matches the polled rendering', async t => {
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Demo</title>\n<style>\n* { box-sizing: border-box; }\n</style></head>\n<body><p>Hello &amp; welcome</p></body>\n</html>';
  const { complete } = await setup(t, ANSWER(html, { realtime: ({ helpers }) => helpers.autoSteps({ deltas: 12 }) }));
  const result = await complete(ask());
  assert.equal(result.message.content, '```html\n' + html + '\n```');
  const chunks = deltas(result);
  assert(chunks[0].startsWith('```html\n<'), 'nothing of the document is shown outside the fence');
  assert(chunks.length >= 3);
  const polled = await (await setup(t, () => ({ markdown: html }), { realtime: null })).complete(ask());
  assert.equal(polled.message.content, result.message.content, 'same final text as the polling path');
});

test('a bare HTML stream survives Linear rich-text indentation and URL conversion', async t => {
  const raw = '<!DOCTYPE html>\n<html><body>\n<svg><path d="M1 2\n    L3 4" /></svg>\n<script>\n  const url = "https://example.org/svg";\n  node.setAttribute("d", `M1 2\n      L3 4`);\n</script>\n</body></html>';
  const rendered = raw.replace('    L3 4', '  L3 4').replace('      L3 4', '  L3 4').replace('  const url', 'const url').replace('  node.setAttribute', 'node.setAttribute').replace('https://example.org/svg', '[https://example.org/svg](https://example.org/svg)');
  assert.equal(htmlRichEquivalent(raw, rendered), true);
  const bodyData = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: rendered }] }] };
  const { complete } = await setup(t, () => ({ markdown: raw, body: rendered, bodyData, hold: true, realtime: ({ helpers }) => helpers.autoSteps({ text: raw, deltas: 25 }) }));
  const result = await complete(ask());
  assert.equal(result.message.content, '```html\n' + raw + '\n```');
  assert.equal(finished(result).streaming.consistency, 'html_rich');
});

test('HTML rich-text matching rejects code edits, whitespace-sensitive text and non-path templates', () => {
  const raw = '<!DOCTYPE html>\n<html><body>\n<span>Hello </span>\n<script>\n  const text = `line 1\n  line 2`;\n  const n = 1 + 2;\n</script>\n</body></html>';
  assert.equal(htmlRichEquivalent(raw, raw.replace('1 + 2', '1 - 2')), false);
  assert.equal(htmlRichEquivalent(raw, raw.replace('  line 2', ' line 2')), false);
  assert.equal(htmlRichEquivalent(raw, raw.replace('Hello ', 'Hello')), false);
  const inline = '<!DOCTYPE html>\n<html><body><span>A</span> <span>B</span></body></html>';
  assert.equal(htmlRichEquivalent(inline, inline.replace('</span> <span>', '</span><span>')), false);
  assert.equal(htmlRichEquivalent(raw.replace('<span>', '<pre>').replace('</span>', '</pre>'), raw.replace('<span>', '<pre>').replace('</span>', '</pre>')), false);
});

test('raw Markdown that Linear normalizes (bullets, fence info) is verified by content and kept as streamed', async t => {
  const raw = 'Choices:\n\n* one\n* two\n\n```python\nprint(1)\n```';
  const normalized = 'Choices:\n\n- one\n- two\n\n```\nprint(1)\n```';
  const { complete } = await setup(t, () => ({ markdown: normalized, hold: true, realtime: ({ helpers }) => helpers.autoSteps({ text: raw, deltas: 7, finalDoc: markdownToDoc(normalized) }) }), { mock: { keepFenceInfo: false } });
  const result = await complete(ask());
  assert.equal(result.message.content, raw);
  assert.equal(finished(result).streaming.consistency, 'body');
});

test('text that contradicts Linear\'s final reply ends the stream with linear_stream_rewritten instead of mixing versions', async t => {
  const { post } = await setup(t, () => ({ markdown: 'Hello world, nice to meet you.', hold: true, realtime: ({ helpers }) => helpers.autoSteps({ text: 'Hello wrld, nice to meet you.', deltas: 4, finalDoc: markdownToDoc('Hello wrld, nice to meet you.') }) }));
  const sse = parseSse(await (await post(ask())).text());
  assert.equal(sse.chunks.at(-1).error.code, 'linear_stream_rewritten');
  const sent = sse.chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
  assert.equal(sent, 'Hello wrld, nice to meet you.', 'nothing of the other version was appended');
});

test('a snapshot that contradicts collected text stops realtime emission; the verified final completes the reply', async t => {
  const { complete } = await setup(t, () => ({
    markdown: 'Alpha beta gamma delta.', hold: true,
    realtime: ({ turn }) => {
      const id = turn.id + ':0', meta = { phase: 'answer', turnId: turn.id };
      return [
        { message: { type: 'text', id, bodyData: { type: 'doc', content: [] }, status: 'inProgress', metadata: meta } },
        { message: { type: 'textDelta', id, delta: 'Alpha beta ' } },
        { delay: 30 }, { message: { type: 'text', id, bodyData: markdownToDoc('Something else entirely'), status: 'inProgress', metadata: meta } },
        { delay: 30 }, { message: { type: 'textDelta', id, delta: 'gamma delta.' } },
        { delay: 30 }, { release: true },
      ];
    },
  }));
  const result = await complete(ask());
  assert.equal(result.message.content, 'Alpha beta gamma delta.');
  const final = finished(result);
  assert.equal(final.streaming.realtime_stopped, 'snapshot_mismatch');
  assert.deepEqual(deltas(result), ['Alpha beta', ' gamma delta.']);
});

test('stale generations are dropped, a split surrogate pair is never sent alone', async t => {
  const { complete } = await setup(t, () => ({
    markdown: 'Smile \u{1F600} done', hold: true,
    realtime: ({ turn }) => {
      const id = turn.id + ':0';
      return [
        { message: { cmd: 'streamData', data: { type: 'text', id, generation: 2, bodyData: { type: 'doc', content: [] }, status: 'inProgress', metadata: { phase: 'answer', turnId: turn.id } } } },
        { message: { cmd: 'streamData', data: { type: 'textDelta', id, generation: 2, delta: 'Smile \ud83d' } } },
        { delay: 30 }, { message: { cmd: 'streamData', data: { type: 'textDelta', id, generation: 1, delta: 'STALE ' } } },
        { delay: 30 }, { message: { cmd: 'streamData', data: { type: 'textDelta', id, generation: 2, delta: '\ude00 done' } } },
        { delay: 30 }, { release: true },
      ];
    },
  }));
  const result = await complete(ask());
  assert.equal(result.message.content, 'Smile \u{1F600} done');
  for (const chunk of deltas(result)) assert(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(chunk), 'every chunk is well-formed UTF-16');
  assert.equal(finished(result).streaming.realtime.stale, 1);
});

test('oversized messages and a silent socket fall back to polling', async t => {
  const big = await setup(t, ANSWER('Fine after a huge message.', { realtime: ({ helpers }) => [...helpers.autoSteps({ deltas: 2, release: false, reasoning: false }).slice(0, 3), { raw: JSON.stringify({ cmd: 'streamData', modelName: 'x', data: 'y'.repeat(5000) }) }] }), { realtime: { maxMessageBytes: 2000 }, releaseAfter: 300 });
  const first = await big.complete(ask());
  assert.equal(first.message.content, 'Fine after a huge message.');
  assert.equal(finished(first).streaming.realtime.fallback_reason, 'message_too_large');
  const silent = await setup(t, () => ({ markdown: 'Recovered by polling.', hold: true, realtime: [{ delay: 2000 }] }), { realtime: { idleTimeoutMs: 120 }, releaseAfter: 400 });
  const second = await silent.complete(ask());
  assert.equal(second.message.content, 'Recovered by polling.');
  assert.equal(finished(second).streaming.realtime.fallback_reason, 'idle_timeout');
});

test('the socket sends heartbeats while Linear is still thinking', async t => {
  const { complete, sync } = await setup(t, ANSWER('Thought for a while.', { realtime: ({ helpers }) => [{ delay: 200 }, ...helpers.autoSteps({ deltas: 2 })] }), { realtime: { pingMs: 40 } });
  const result = await complete(ask());
  assert.equal(result.message.content, 'Thought for a while.');
  const pings = sync.connections[0].commands.filter(c => c.cmd === 'ping');
  assert(pings.length >= 2 && pings.every((p, i) => p.id === i + 1));
  assert(finished(result).streaming.realtime.pongs >= 2);
});

const tool = (name, properties) => ({ type: 'function', function: { name, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } });
const tools = [tool('write_file', { path: { type: 'string' }, content: { type: 'string' } })];

test('tool mode streams only the text before the tool block; the call is sent once validated', async t => {
  const intro = "I'll create index.html now.\nIt will contain a heading.";
  const { complete } = await setup(t, turn => ({ markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'write_file', arguments: { path: 'index.html', content: '<h1>Hi</h1>' } }], intro), hold: true, realtime: ({ helpers }) => helpers.autoSteps({ deltas: 40 }) }));
  const result = await complete({ ...ask('create index.html'), tools });
  assert.equal(result.finish, 'tool_calls');
  assert.equal(result.message.content, intro);
  const chunks = deltas(result);
  assert(chunks.length >= 2, 'the intro streamed line by line before the reply finished');
  assert(chunks.every(chunk => !/```|tool_calls|nonce|lgw-|\{/.test(chunk)), 'no protocol text is shown');
  assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { path: 'index.html', content: '<h1>Hi</h1>' });
  const final = finished(result);
  assert.equal(final.streaming.source, 'realtime');
  assert.equal(final.streaming.realtime_stopped, 'tool_protocol');
  assert(final.timings.first_text_ms <= final.timings.upstream_complete_ms);
  assert(final.timings.first_tool_call_ms >= final.timings.upstream_complete_ms, 'tool calls wait for the complete, validated reply');
});

test('an invalid streamed tool call is repaired without leaking its arguments or the first attempt', async t => {
  const intro = 'Let me write the file.';
  const { complete, upstream } = await setup(t, turn => turn.sendIndex === 0
    ? { markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'write_file', arguments: { path: 'SECRET_BAD_ARGS' } }], intro), hold: true, realtime: ({ helpers }) => helpers.autoSteps({ deltas: 25 }) }
    : { markdown: toolCallBlock(nonceOf(turn.doc), [{ name: 'write_file', arguments: { path: 'a.txt', content: 'ok' } }]) });
  const result = await complete({ ...ask('write a.txt'), tools });
  assert.equal(upstream.sends.length, 2, 'one repair turn');
  assert.equal(result.message.content, intro);
  assert.equal(result.message.tool_calls.length, 1);
  assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { path: 'a.txt', content: 'ok' });
  assert(!JSON.stringify(result.chunks).includes('SECRET_BAD_ARGS'));
  assert.equal(finished(result).tool_protocol.repair_attempts, 1);
});

test('consistency skeletons ignore formatting but not words, and splicing never repeats or drops words', () => {
  const raw = '* a\n* b\n\n1) one\n1) two\n\n```python\nx = 1\n```\n[link](https://x.y) &amp; done\n- [x] task';
  const rich = '- a\n- b\n\n1. one\n2. two\n\n```\nx = 1\n```\n[link](https://other.example) & done\n- task';
  assert.equal(skeleton(raw), skeleton(rich));
  assert.notEqual(skeleton('Hello wrld'), skeleton('Hello world'));
  assert.equal(contentSkeleton('a😀b').count, 2);
  assert.equal(spliceRest('Steps:\n\n* fir', 'Steps:\n\n- first\n- second'), 'st\n- second');
  assert.equal(spliceRest('Para one.', 'Para one.\n\nPara two.'), '\n\nPara two.');
  assert.equal(spliceRest('The **bold**', 'The __bold__ text'), ' text');
  assert.equal(spliceRest('Hello wrld', 'Hello world'), null);
  assert.equal(spliceRest('', 'anything'), 'anything');
  assert.equal(spliceRest('Extra words here', 'Extra'), null);
});

test('final consistency preserves operators, punctuation, URLs, identifiers and code whitespace', () => {
  for (const [before, after] of [
    ['```js\nconst n = a+b;\n```', '```js\nconst n = a-b;\n```'],
    ['```js\nreturn x !== y;\n```', '```js\nreturn x === y;\n```'],
    ['Price: 1.5', 'Price: 15'],
    ['Value: -12', 'Value: 12'],
    ['[download](https://safe.example/a)', '[download](https://other.example/a)'],
    ['Fixed ENG-123', 'Fixed ENG-456'],
    ['Result 😀', 'Result 😞'],
    ['```py\nif ok:\n  run()\n```', '```py\nif ok:\nrun()\n```'],
    ['```py\n  run()\n```', '```py\nrun()\n```'],
    ['`x `', '`x`'],
  ]) {
    assert.equal(sameContent(before, after), null, `${before} must differ from ${after}`);
    assert.equal(spliceRest(before, after + ' extra'), null);
  }
  assert(sameContent('* first\n* second', '- first\n- second'));
  assert(sameContent('The **bold** text', 'The __bold__ text'));
});

test('an operator-only final rewrite fails instead of returning incorrect streamed code', async t => {
  const { post } = await setup(t, ANSWER('```js\nconst n = a-b;\n```', {
    realtime: ({ helpers }) => helpers.autoSteps({ text: '```js\nconst n = a+b;\n```' }),
  }));
  const result = parseSse(await (await post(ask('write a calculation'))).text());
  assert.equal(result.chunks.at(-1).error?.code, 'linear_stream_rewritten');
});

test('an explicit foreign turn is rejected even when the part ID resembles the current turn', () => {
  const turn = turnWith();
  turn.applyMessage(textMessage('turn-1:0', { type: 'doc', content: [] }, { metadata: { phase: 'answer', turnId: 'old-turn' } }));
  turn.applyMessage(deltaMessage('turn-1:0', 'OLD TURN SECRET'));
  assert.equal(turn.parts.get('turn-1:0').ours, false);
  assert.equal(new LiveText().fromRealtime(turn), '');
});

test('a real Linear opening code-block step restores the fence omitted from delta', () => {
  for (const opening of ['html\n', 'html']) {
    const turn = turnWith();
    turn.applyMessage(textMessage('turn-1:0', { type: 'doc', content: [{ type: 'paragraph' }] }));
    turn.applyMessage(deltaMessage('turn-1:0', opening, {
      steps: [{ stepType: 'replace', from: 0, to: 2, slice: { content: [{ type: 'code_block', attrs: { language: 'html' } }] } }],
    }));
    turn.applyMessage(deltaMessage('turn-1:0', (opening.endsWith('\n') ? '' : '\n') + '<html></html>\n```'));
    const part = turn.parts.get('turn-1:0');
    assert.equal(part.raw, '```html\n<html></html>\n```');
    assert.equal(verifyPart(part, { body: part.raw, bodyData: markdownToDoc(part.raw) }), 'exact');
    const live = new LiveText();
    assert.equal(live.fromRealtime(turn), part.raw);
  }
});

test('live forms hold back unstable characters, fence HTML documents and stop tool text at protocol lines', () => {
  assert.equal(holdTrailing('abc \n'), 'abc');
  assert.equal(holdTrailing('x\ud83d'), 'x');
  assert.equal(htmlStart('<ht'), null);
  assert.equal(htmlStart('<html>'), 'html');
  assert.equal(htmlStart('<!doctype html>'), 'html');
  assert.equal(htmlStart('<htmlx'), 'text');
  assert.equal(htmlStart('Hello'), 'text');
  assert.deepEqual(liveForm({ raw: '<!doc' }), { text: '', held: true });
  assert.equal(liveForm({ raw: '<!doc' }, { final: true }).text, '<!doc');
  assert.equal(liveForm({ raw: '\n<html>\n<body>' }).text, '```html\n<html>\n<body>');
  assert.equal(liveForm({ raw: '<html>\n</html>\n' }, { final: true }).text, '```html\n<html>\n</html>\n```');
  const tool = { raw: 'Plan.\nNext line\n\n```tool_calls\n{"nonce":"lgw-1"' };
  assert.deepEqual(liveForm(tool, { stopAtCode: true }), { text: 'Plan.\nNext line', frozen: true });
  assert.deepEqual(liveForm({ raw: 'Partial li' }, { stopAtCode: true }), { text: '', frozen: false });
  assert.equal(liveForm({ raw: 'Intro\n{' }, { stopAtCode: true }).frozen, false, 'an incomplete line is not judged yet');
  assert.equal(liveForm({ raw: 'Intro\n{\n' }, { stopAtCode: true }).frozen, true);
});

function turnWith(assistantMessageId = 'turn-1', scope = 'turn') {
  return new TurnStream({ assistantMessageId, scope, now: (() => { let t = 0; return () => ++t; })() });
}
const textMessage = (id, doc, extra = {}) => ({ cmd: 'streamData', data: { type: 'text', id, bodyData: doc, status: 'inProgress', metadata: { phase: 'answer', turnId: 'turn-1' }, ...extra } });
const deltaMessage = (id, delta, extra = {}) => ({ cmd: 'streamData', data: { type: 'textDelta', id, delta, ...extra } });

test('turn streams anchor a part only when its start was seen', () => {
  const empty = turnWith();
  empty.applyMessage(textMessage('p', { type: 'doc', content: [{ type: 'paragraph' }] }));
  empty.applyMessage(deltaMessage('p', 'Hello'));
  assert.equal(empty.parts.get('p').raw, 'Hello');
  assert.equal(empty.parts.get('p').anchor, 'empty_snapshot');
  const late = turnWith();
  late.applyMessage(deltaMessage('p', 'world, part two'));
  late.applyMessage(textMessage('p', markdownToDoc('# Title\n\nworld, part two')));
  assert.equal(late.parts.get('p').anchored, false, 'a missed heading marker blocks the anchor');
  const confirmed = turnWith();
  confirmed.applyMessage(deltaMessage('p', 'Hello there'));
  confirmed.applyMessage(textMessage('p', markdownToDoc('Hello there')));
  assert.equal(confirmed.parts.get('p').anchor, 'confirmed');
  const stepped = turnWith();
  stepped.applyMessage(deltaMessage('p', 'Start', { steps: [{ stepType: 'replace', from: 1, to: 1 }] }));
  assert.equal(stepped.parts.get('p').anchored, false, 'identity is still unknown');
  stepped.identifyFromRead([{ id: 'p', type: 'text', metadata: { phase: 'answer', turnId: 'turn-1' } }]);
  assert.equal(stepped.parts.get('p').anchor, 'step_start');
  const middle = turnWith();
  middle.identifyFromRead([]);
  middle.applyMessage(textMessage('p', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Some text already ' }, { type: 'text', text: 'bold', marks: [{ type: 'strong' }] }] }] }));
  middle.applyMessage(deltaMessage('p', ' more'));
  assert.equal(middle.parts.get('p').anchored, false, 'a structured mid-stream snapshot is not an anchor');
});

test('turn streams drop duplicates and foreign parts, and close earlier parts when a later one starts', () => {
  const turn = turnWith('turn-1', 'conversation');
  turn.applyMessage(textMessage('a', { type: 'doc', content: [] }));
  turn.applyMessage({ ...deltaMessage('a', 'one'), cursor: 5 });
  turn.applyMessage({ ...deltaMessage('a', 'one'), cursor: 5 });
  turn.applyMessage({ ...deltaMessage('a', 'zero'), cursor: 4 });
  turn.applyMessage({ cmd: 'streamData', data: { type: 'text', id: 'old', bodyData: { type: 'doc', content: [] }, metadata: { phase: 'answer', turnId: 'turn-0' } } });
  turn.applyMessage(deltaMessage('old', 'LEAK'));
  turn.applyMessage(textMessage('b', { type: 'doc', content: [] }));
  turn.applyMessage(deltaMessage('b', 'two'));
  assert.equal(turn.parts.get('a').raw, 'one');
  assert.equal(turn.stats.duplicates, 2);
  assert.equal(turn.parts.get('old').ours, false);
  assert.equal(turn.parts.get('a').closed, true);
  const live = new LiveText();
  assert.equal(live.fromRealtime(turn), 'one\n\ntwo');
  turn.applyMessage(deltaMessage('a', ' late'));
  assert.equal(turn.diverged, 'late_delta');
  assert.equal(live.fromRealtime(turn), '');
  assert.equal(live.frozen, 'late_delta');
});

test('same cursor and length do not make different realtime deltas duplicates', () => {
  const turn = turnWith('turn-1', 'conversation');
  turn.applyMessage(textMessage('a', { type: 'doc', content: [] }));
  const first = { ...deltaMessage('a', 'abc'), cursor: 5 };
  const second = { ...deltaMessage('a', 'def'), cursor: 5 };
  turn.applyMessage(first);
  turn.applyMessage(second);
  turn.applyMessage(second);
  assert.equal(turn.parts.get('a').raw, 'abcdef');
  assert.equal(turn.stats.duplicates, 1);
});

test('verification accepts the body, the rich rendering or mention-only differences, and rejects plain-text deltas', () => {
  const part = raw => ({ raw });
  assert.equal(verifyPart(part('Same **text**'), { body: 'Same **text**', bodyData: markdownToDoc('Same **text**') }), 'exact');
  assert.equal(verifyPart(part('1) a\n1) b'), { body: null, bodyData: markdownToDoc('- a\n- b') }), 'rich');
  assert.equal(verifyPart(part('Fixed in ENG-123 :tada:'), { bodyData: markdownToDoc('Fixed in') }), null, 'issue and emoji tokens are content, not removable formatting');
  assert.equal(verifyPart(part('Run this code: print 1'), { bodyData: markdownToDoc('Run this code:\n\n```\nprint 1\n```') }), null, 'deltas without Markdown syntax are not trusted');
  assert.equal(verifyPart(part('Different words'), { bodyData: markdownToDoc('Other words') }), null);
});

test('realtime settings: identity, URL allow-list, timing marks and environment configuration', () => {
  assert.deepEqual(realtimeIdentity({ cookie: 'c', user: 'u-1', useraccount: 'a-1', 'linear-client-version': '84778' }).identity, { userId: 'u-1', userAccountId: 'a-1', clientVersion: '84778' });
  assert.equal(realtimeIdentity({ cookie: 'c', user: 'u-1', useraccount: 'a-1' }).reason, 'missing_client_version');
  assert.equal(realtimeIdentity({ user: 'u', useraccount: 'a', 'linear-client-version': '1' }).reason, 'missing_cookie');
  assert.equal(isLinearRealtimeUrl('wss://sync.linear.app/'), true);
  for (const url of ['ws://sync.linear.app/', 'wss://sync.linear.app.evil.example/', 'wss://evil.example/', 'wss://user:pw@sync.linear.app/', 'wss://sync.linear.app:8443/']) assert.equal(isLinearRealtimeUrl(url), false, url);
  const timing = createTiming((() => { let t = 100; return () => (t += 10); })());
  timing.start();
  timing.mark('send_ack');
  timing.mark('send_ack');
  assert.deepEqual(timing.snapshot(), { send_ack_ms: 10 });
  assert.deepEqual(readConfig({}).realtime, { mode: 'ws', subscription: 'conversation', url: 'wss://sync.linear.app/', clientVersion: '', connectTimeoutMs: 5000, healthyPollMs: 3000, maxMessageBytes: 4 * 1024 * 1024 });
  const custom = readConfig({ LINEAR_REALTIME: 'off', LINEAR_REALTIME_SUBSCRIPTION: 'conversation', LINEAR_REALTIME_CLIENT_VERSION: '84778', LINEAR_REALTIME_POLL_MS: '2000', LINEAR_TIMING_LOG: '0' });
  assert.equal(custom.realtime.mode, 'off');
  assert.equal(custom.realtime.subscription, 'conversation');
  assert.equal(custom.realtime.clientVersion, '84778');
  assert.equal(custom.realtime.healthyPollMs, 2000);
  assert.equal(custom.timingLog, false);
  assert.throws(() => readConfig({ LINEAR_REALTIME: 'yes' }), /LINEAR_REALTIME/);
  assert.throws(() => readConfig({ LINEAR_REALTIME_URL: 'wss://example.com/' }), /LINEAR_REALTIME_URL/);
  assert.throws(() => readConfig({ LINEAR_REALTIME_CLIENT_VERSION: 'bad version' }), /CLIENT_VERSION/);
});

test('a channel never throws into the request: broken sockets and consumers become a fallback reason', async () => {
  class Throwing { constructor() { throw new Error('boom'); } }
  const broken = new RealtimeChannel({ cookie: 'c', user: 'u', useraccount: 'a', 'linear-client-version': '1' }, {}, { WebSocketImpl: Throwing });
  broken.start();
  assert.equal(broken.failure.reason, 'connect_failed');
  const missing = new RealtimeChannel({ cookie: 'c', user: 'u', useraccount: 'a', 'linear-client-version': '1' }, {}, { WebSocketImpl: undefined });
  missing.WebSocketImpl = undefined;
  missing.start();
  assert.equal(missing.failure.reason, 'websocket_unavailable');
  assert.equal(missing.close().state, 'failed');
});

test('production wiring: a stored account\'s own cookie and identity open the channel, with no client factory', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const { AccountStore } = await import('../accounts.mjs');
  const { ENDPOINT } = await import('../upstream.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-realtime-test-'));
  const upstream = new MockLinear({ model: ANSWER('Answer from the stored account.') });
  const sync = await new MockSync({ upstream }).listen();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => url === ENDPOINT ? upstream.fetch(url, options) : realFetch(url, options);
  t.after(async () => { globalThis.fetch = realFetch; await sync.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const store = new AccountStore(pathToFileURL(temp + path.sep));
  await store.initialize();
  await store.import({ endpoint: ENDPOINT, headers: { cookie: 'STORED_ACCOUNT_COOKIE', user: 'user-a', organization: 'org-a', useraccount: 'account-a', 'linear-client-version': '84778', 'user-agent': 'StoredAgent/2' } });
  const targets = [];
  // Stands in for the network: records the requested Linear URL and connects to the mock instead.
  class Redirect extends WebSocket {
    constructor(url, init) { const target = new URL(url); targets.push(target); super(sync.url + target.search, init); }
  }
  assert.throws(() => createGateway({ apiKey: 'test-key', accountStore: store, realtime: { mode: 'ws', url: 'wss://attacker.example/' } }), /realtime URL/);
  const server = createGateway({ apiKey: 'test-key', accountStore: store, pollMs: 5, timeoutMs: 5000, realtime: { mode: 'ws', healthyPollMs: 40, quietMs: 30, WebSocketImpl: Redirect } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  const result = await client(`http://127.0.0.1:${server.address().port}`).complete(ask());
  assert.equal(result.message.content, 'Answer from the stored account.');
  assert.equal(finished(result).streaming.source, 'realtime');
  assert.equal(targets[0].origin, 'wss://sync.linear.app');
  assert.equal(targets[0].searchParams.get('userAccountId'), 'account-a');
  assert.equal(sync.connections[0].headers.cookie, 'STORED_ACCOUNT_COOKIE');
  assert.equal(sync.connections[0].headers['user-agent'], 'StoredAgent/2');
  assert.equal(sync.connections[0].commands[0].clientVersion, '84778');
  // With realtime off the same wiring never constructs a socket.
  const before = targets.length;
  const off = createGateway({ apiKey: 'test-key', accountStore: store, pollMs: 5, timeoutMs: 5000, realtime: { mode: 'off', WebSocketImpl: Redirect } });
  off.listen(0, '127.0.0.1');
  await once(off, 'listening');
  t.after(() => off.shutdown());
  const plain = new MockLinear({ model: () => ({ markdown: 'Polled reply.' }) });
  globalThis.fetch = (url, options) => url === ENDPOINT ? plain.fetch(url, options) : realFetch(url, options);
  const polled = await client(`http://127.0.0.1:${off.address().port}`).complete(ask());
  assert.equal(polled.message.content, 'Polled reply.');
  assert.equal(targets.length, before);
}, { timeout: 10000 });

test('the timing log has timings and fallback reasons but no content', async t => {
  const events = [];
  const { complete } = await setup(t, ANSWER('Private reply content.'), { gateway: { onTiming: event => events.push(event) } });
  await complete(ask('private question'));
  const [event] = events;
  assert.equal(event.event, 'chat_timing');
  assert.equal(event.realtime, 'streamed');
  assert.equal(event.source, 'realtime');
  for (const key of ['send_ack_ms', 'first_stream_event_ms', 'first_text_ms', 'upstream_complete_ms', 'finish_ms']) assert(Number.isInteger(event[key]), key);
  assert(!/Private|private|MOCK_ONLY_COOKIE|mock-user|turn-/.test(JSON.stringify(event)));
});

test('a long reply is delivered in coalesced batches and still ends exactly', async t => {
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i}: ` + 'lorem ipsum '.repeat(8)).join('\n');
  const { complete } = await setup(t, ANSWER(long, { realtime: ({ helpers }) => [...helpers.autoSteps({ deltas: 600, delay: 0, release: false }), { delay: 200 }, { release: true }] }));
  const result = await complete(ask());
  assert.equal(finished(result).streaming.source, 'realtime');
  assert.equal(result.message.content, long.trimEnd());
  const chunks = deltas(result).length;
  assert(chunks > 1 && chunks < 600, `coalesced into ${chunks} chunks`);
});

test('x-linear-realtime: off keeps one request on polling for A/B timing checks', async t => {
  const { post, sync } = await setup(t, () => ({ markdown: 'Polled on request.', hold: true }), { releaseAfter: 150 });
  const response = await post(ask(), { headers: { 'x-linear-realtime': 'off' } });
  const sse = parseSse(await response.text());
  assert.equal(sse.chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join(''), 'Polled on request.');
  assert.equal(sync.connections.length, 0);
  assert.equal(sse.chunks.at(-1).streaming.realtime, undefined);
});

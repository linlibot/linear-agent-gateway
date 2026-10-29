// Measures first-text latency through a running gateway, with and without the realtime
// channel, for a short greeting, a longer answer, an HTML/code answer and one tool call.
// It sends real Linear requests (uses account quota) but never executes a tool call,
// never prints the key, and records only timings, sizes and SHA-256 hashes of replies.
//
// Usage:
//   LINEAR_GATEWAY_KEY=<client key from /keys> node scripts/probe-realtime.mjs \
//     --base https://your-gateway/v1 [--model linear-agent] [--scenarios greeting,long,html,tool]
//     [--compare] [--rounds 1] [--out outputs/realtime-probe.json]
// --compare repeats every scenario with the request header `x-linear-realtime: off`
// (the gateway then polls as before), so both paths are measured against one deployment.

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const argument = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const key = process.env.LINEAR_GATEWAY_KEY;
const base = (argument('base') ?? 'http://127.0.0.1:8089/v1').replace(/\/+$/, '');
const model = argument('model') ?? 'linear-agent';
const rounds = Math.max(1, Number(argument('rounds') ?? 1) || 1);
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

const SCENARIOS = {
  greeting: { messages: [{ role: 'user', content: '你好' }] },
  long: { messages: [{ role: 'user', content: '请用中文写一篇约 1000 字的说明文，介绍 HTTP/2 和 HTTP/3 的主要区别，分 5 段，不要使用表格。' }] },
  html: { messages: [{ role: 'user', content: '只输出一个完整的 HTML 页面，不要任何解释：页面上有一个计数按钮，包含内联 CSS 和 JavaScript。' }] },
  tool: {
    messages: [{ role: 'user', content: '请调用 write_file 工具，在 notes.txt 中写入 hello。不要做别的事。' }],
    tools: [{ type: 'function', function: { name: 'write_file', description: 'Write a text file in the workspace (the probe never executes it).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }],
  },
};

async function run(name, realtime) {
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);
  const response = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(realtime ? {} : { 'x-linear-realtime': 'off' }) },
    body: JSON.stringify({ model, stream: true, ...SCENARIOS[name] }),
    signal: AbortSignal.timeout(240000),
  });
  const row = { scenario: name, realtime_requested: realtime, http_status: response.status, headers_ms: at() };
  if (!response.ok) return { ...row, error: (await response.json().catch(() => ({})))?.error?.code ?? 'http_error' };
  const decoder = new TextDecoder();
  let buffer = '', content = '', chunks = 0, toolCalls = [], final = null, error = null, done = false;
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (!event.startsWith('data: ')) continue;
      const data = event.slice(6);
      row.first_event_ms ??= at();
      if (data === '[DONE]') { done = true; row.done_ms = at(); continue; }
      const chunk = JSON.parse(data);
      if (chunk.error) { error = chunk.error.code; continue; }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) { row.first_text_ms ??= at(); content += choice.delta.content; chunks++; }
      for (const call of choice?.delta?.tool_calls ?? []) {
        row.first_tool_call_ms ??= at();
        toolCalls[call.index] ??= { name: call.function?.name, arguments: '' };
        toolCalls[call.index].arguments += call.function?.arguments ?? '';
      }
      if (choice?.finish_reason) final = chunk;
    }
  }
  const validTools = toolCalls.every(call => { try { JSON.parse(call.arguments); return true; } catch { return false; } });
  return {
    ...row, done, error, finish_reason: final?.choices?.[0]?.finish_reason ?? null,
    content_chunks: chunks, content_chars: content.length, content_sha256: content ? sha(content) : null,
    tool_calls: toolCalls.map(call => call.name), tool_arguments_valid_json: validTools,
    gateway_timings: final?.timings ?? null,
    streaming: final?.streaming ? { source: final.streaming.source, consistency: final.streaming.consistency ?? null, realtime_stopped: final.streaming.realtime_stopped ?? null, realtime_status: final.streaming.realtime?.status ?? null, fallback_reason: final.streaming.realtime?.fallback_reason ?? null, answer_deltas: final.streaming.realtime?.answer_deltas ?? 0, anchors: final.streaming.realtime?.anchors ?? [] } : null,
    integrity_ok: done && !error && Boolean(final) && (content.length > 0 || toolCalls.length > 0) && validTools,
  };
}

if (process.argv.includes('--help')) { console.log('See the header of scripts/probe-realtime.mjs for usage.'); process.exit(0); }
if (!key) { console.error('Set LINEAR_GATEWAY_KEY to a client key created at /keys.'); process.exit(2); }
const names = (argument('scenarios') ?? 'greeting,long,html,tool').split(',').map(s => s.trim()).filter(Boolean);
for (const name of names) if (!SCENARIOS[name]) { console.error('Unknown scenario: ' + name); process.exit(2); }
const results = [];
for (let round = 0; round < rounds; round++) {
  for (const name of names) {
    for (const realtime of process.argv.includes('--compare') ? [true, false] : [true]) {
      const result = { round, ...await run(name, realtime).catch(error => ({ scenario: name, realtime_requested: realtime, error: error.name })) };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
}
const report = { checked_at: new Date().toISOString(), base_host: new URL(base).host, model, results };
const out = argument('out');
if (out) { await fs.writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log('Wrote ' + out); }
console.table(results.map(r => ({ scenario: r.scenario, realtime: r.realtime_requested, source: r.streaming?.source ?? '-', send_ack: r.gateway_timings?.send_ack_ms ?? '-', first_event: r.gateway_timings?.first_stream_event_ms ?? '-', first_text_client: r.first_text_ms ?? '-', first_tool_client: r.first_tool_call_ms ?? '-', done_client: r.done_ms ?? '-', ok: r.integrity_ok ?? false, fallback: r.streaming?.fallback_reason ?? '' })));

// OpenAI-compatible chat.completion.chunk writer.

import { MODEL } from './upstream.mjs';

const ARGUMENT_CHUNK = 8192;

function splitText(text, size) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--; // keep surrogate pairs together
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces.length ? pieces : [''];
}

export class ChatStream {
  constructor(res, { id, created }) {
    this.res = res;
    this.id = id;
    this.created = created;
    this.metadata = {};
    this.started = false;
    this.heartbeat = null;
  }
  chunk(delta, finishReason = null, extra = {}) {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: MODEL, ...this.metadata, ...extra, choices: [{ index: 0, delta, finish_reason: finishReason }] };
  }
  write(value) {
    if (!this.res.destroyed && !this.res.writableEnded) this.res.write('data: ' + JSON.stringify(value) + '\n\n');
  }
  start(metadata) {
    this.metadata = metadata;
    this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    this.started = true;
    this.write(this.chunk({ role: 'assistant' }));
    this.heartbeat = setInterval(() => { if (!this.res.destroyed) this.res.write(': waiting for Linear\n\n'); }, 15000);
  }
  content(text) {
    if (text) this.write(this.chunk({ content: text }));
  }
  toolCalls(calls) {
    calls.forEach((call, index) => {
      this.write(this.chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }));
      for (const piece of splitText(call.function.arguments, ARGUMENT_CHUNK)) this.write(this.chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
    });
  }
  finish(finishReason, extra = {}, includeUsage = false) {
    this.write(this.chunk({}, finishReason, extra));
    if (includeUsage) this.write({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: MODEL, ...this.metadata, choices: [], usage: null });
    this.stop();
    if (!this.res.destroyed) this.res.end('data: [DONE]\n\n');
  }
  fail(payload) {
    this.stop();
    if (!this.res.destroyed) this.res.end('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n');
  }
  stop() { clearInterval(this.heartbeat); this.heartbeat = null; }
}

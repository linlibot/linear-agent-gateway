// A scripted stand-in for Linear's realtime sync WebSocket (wss://sync.linear.app).
// It speaks just enough RFC 6455 for Node's built-in WebSocket client, records the
// upgrade headers and every client command, answers the hshk handshake, and on a
// streamData subscription plays a script of streamData messages for the MockLinear
// turn it refers to. It never contacts Linear.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { markdownToDoc } from './mock-linear.mjs';
import { realtimeFactory } from '../realtime.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = data.length < 126 ? Buffer.from([0x80 | opcode, data.length])
    : data.length < 65536 ? Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
  return Buffer.concat([head, data]);
}

class Connection {
  constructor(sync, req, socket) {
    Object.assign(this, { sync, socket, headers: req.headers, url: new URL(req.url, 'http://mock'), commands: [], closed: false, subscriptions: [] });
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    socket.on('data', chunk => this.data(chunk));
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => {});
  }
  data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0, opcode = this.buffer[0] & 15, masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 127, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 8) { this.write(frame(8, payload.subarray(0, 2))); this.socket.end(); this.closed = true; return; }
      if (opcode === 9) { this.write(frame(10, payload)); continue; }
      if (opcode === 10) continue;
      this.fragments.push(payload);
      if (!fin) continue;
      const message = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.command(message);
    }
  }
  write(buffer) { if (!this.closed && !this.socket.destroyed) this.socket.write(buffer); }
  send(value) { this.write(frame(1, typeof value === 'string' ? value : JSON.stringify(value))); }
  sendBinary(buffer) { this.write(frame(2, buffer)); }
  /** Orderly close initiated by the server. */
  close(code = 1000) { const b = Buffer.alloc(2); b.writeUInt16BE(code); this.write(frame(8, b)); setTimeout(() => this.socket.destroy(), 50).unref(); }
  /** Connection lost without a close frame. */
  drop() { this.closed = true; this.socket.destroy(); }
  command(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    this.commands.push(message);
    const { sync } = this;
    if (message.cmd === 'hshk') {
      const mode = sync.handshake;
      if (mode === 'ok') this.send({ cmd: 'hshk', sync: { lastSyncId: 1, lastSequentialSyncId: 1, subscribedSyncGroups: [] } });
      else if (mode === 'noauth') this.send({ cmd: 'noauth' });
      else if (mode === 'no_sync') this.send({ cmd: 'hshk' });
      else if (mode === 'close') this.close(4001);
      else if (mode === 'drop') this.drop();
      return;
    }
    if (message.cmd === 'ping') { if (sync.pong) this.send({ cmd: 'pong', id: message.id }); return; }
    if (message.cmd === 'streamData' && message.action === 'subscribe') {
      this.subscriptions.push(message);
      this.sync.play(this, message).catch(error => { this.sync.errors.push(error); });
    }
  }
}

/**
 * new MockSync({ upstream, script }) where script({ turn, conversation, reply, subscription, helpers })
 * returns steps: { message } | { delay } | { release: true } | { close: code } | { drop: true } | { raw } | { binary }.
 * Without a script, the reply's `realtime` field (steps, or 'auto') decides; 'auto' streams
 * the reply Markdown as text/textDelta messages and then releases the held GraphQL turn.
 */
export class MockSync {
  constructor({ upstream, script = null, handshake = 'ok', pong = true, upgrade = true } = {}) {
    Object.assign(this, { upstream, script, handshake, pong, upgrade });
    this.connections = [];
    this.errors = [];
    this.server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    this.server.on('upgrade', (req, socket) => {
      if (!this.upgrade) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      this.connections.push(new Connection(this, req, socket));
    });
  }
  async listen() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `ws://127.0.0.1:${this.server.address().port}/`;
    return this;
  }
  async close() {
    for (const connection of this.connections) connection.drop();
    this.server.closeAllConnections?.();
    await new Promise(resolve => this.server.close(resolve));
  }
  /** A realtime channel factory pointed at this mock (test-only URL, short timeouts). */
  factory(overrides = {}) {
    return realtimeFactory({ url: this.url, connectTimeoutMs: 2000, healthyPollMs: 40, quietMs: 30, pingMs: 1000, idleTimeoutMs: 5000, ...overrides });
  }
  get open() { return this.connections.filter(c => !c.closed).length; }
  async play(connection, subscription) {
    const entry = subscription.modelName === 'AiConversationTurn'
      ? this.upstream.turnsById.get(subscription.modelId)
      : [...this.upstream.turnsById.values()].filter(e => e.conversation.id === subscription.modelId).at(-1);
    if (!entry) return;
    const { turn, conversation } = entry;
    const reply = turn.reply;
    const helpers = { stream: (data, extra = {}) => ({ cmd: 'streamData', modelName: subscription.modelName, modelId: subscription.modelId, propertyName: 'parts', data, ...extra }), autoSteps: options => autoSteps(turn, reply, options) };
    const steps = this.script ? this.script({ turn, conversation, reply, subscription, helpers, connection }) : reply.realtime === 'auto' ? autoSteps(turn, reply) : typeof reply.realtime === 'function' ? reply.realtime({ turn, conversation, subscription, helpers, connection }) : reply.realtime ?? [];
    for (const step of steps) {
      if (connection.closed) return;
      if (step.delay) await sleep(step.delay, undefined, { ref: false });
      // A bare data object or a streamData envelope without model fields targets this subscription.
      if (step.message) connection.send(!step.message.cmd ? helpers.stream(step.message) : step.message.cmd === 'streamData' ? { modelName: subscription.modelName, modelId: subscription.modelId, propertyName: 'parts', ...step.message } : step.message);
      if (step.raw !== undefined) connection.send(step.raw);
      if (step.binary) connection.sendBinary(step.binary);
      if (step.release) this.upstream.release(turn.id);
      if (step.close) { connection.close(step.close); return; }
      if (step.drop) { connection.drop(); return; }
    }
  }
}

/** Splits text into about `count` pieces at arbitrary positions (like token deltas), keeping surrogate pairs. */
export function pieces(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end++;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * Steps for one answer part: an empty "inProgress" text snapshot, deltas, a final
 * "complete" snapshot, then the GraphQL release. Reasoning messages come first.
 */
export function autoSteps(turn, reply, { deltas = 8, delay = 3, partId = turn.id + ':0', phase = 'answer', release = true, cursor = true, text = reply.markdown ?? '', reasoning = true, finalDoc = markdownToDoc(text) } = {}) {
  let n = 0;
  const wrap = data => ({ message: { cmd: 'streamData', data, ...(cursor ? { cursor: String(++n) } : {}) } });
  const steps = [];
  if (reasoning) {
    steps.push(wrap({ type: 'reasoning', id: turn.id + ':r', bodyData: markdownToDoc('SECRET REASONING'), status: 'inProgress', metadata: { phase: 'reasoning', turnId: turn.id } }));
    steps.push(wrap({ type: 'reasoningDelta', id: turn.id + ':r', delta: 'SECRET REASONING DELTA' }));
  }
  steps.push(wrap({ type: 'text', id: partId, bodyData: { type: 'doc', content: [{ type: 'paragraph' }] }, status: 'inProgress', metadata: { phase, turnId: turn.id } }));
  for (const piece of pieces(text, deltas)) steps.push({ delay }, wrap({ type: 'textDelta', id: partId, delta: piece, steps: [] }));
  steps.push({ delay }, wrap({ type: 'text', id: partId, bodyData: finalDoc, status: 'complete', metadata: { phase, turnId: turn.id } }));
  if (release) steps.push({ release: true });
  return steps;
}

// Linear's realtime body channel (the sync WebSocket used by linear.app).
//
// One socket per streamed request is opened in parallel with the GraphQL send. After
// Linear accepts the message, the gateway subscribes to the parts of exactly that
// assistant turn and collects answer-phase text while Linear generates it. The
// channel only adds early text: GraphQL polling stays the source of truth for
// completion, errors and the final reply, and every failure here (no identity,
// noauth, timeout, malformed or oversized messages, disconnect) falls back to
// polling the same conversation. Nothing is ever resent upstream because of it.
//
// Only messages for the subscribed model, the current turn and phase=answer count;
// reasoning, commentary, other turns and other conversations are ignored. A part's
// text is used only once the stream has shown it from its start (an empty or plain
// snapshot, a snapshot confirming the buffered deltas, or a first step at the start
// of the document). Later snapshots are checked against the accumulated text.

import { richText } from './upstream.mjs';
import { skeleton } from './consistency.mjs';

export const REALTIME_URL = 'wss://sync.linear.app/';
export const REALTIME_MODES = ['ws', 'off'];
export const REALTIME_SUBSCRIPTIONS = ['turn', 'conversation'];
export const DEFAULT_REALTIME = Object.freeze({
  mode: 'ws', subscription: 'conversation', url: REALTIME_URL, clientVersion: '',
  connectTimeoutMs: 5000, idleTimeoutMs: 60000, pingMs: 20000, quietMs: 600, healthyPollMs: 3000, coalesceMs: 15,
  maxMessageBytes: 4 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
});
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_VERSION = /^[A-Za-z0-9_.+-]{1,128}$/;
const TERMINAL = /^(?:complete|completed|done|finished|final|succeeded)$/i;
const MAX_PARTS = 512, MAX_SEEN = 50000, MAX_PENDING = 4 * 1024 * 1024, SNAPSHOT_CHECK_MS = 250, COALESCE_FROM = 32 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Realtime is valid only for wss URLs on linear.app hosts, so the cookie never goes elsewhere. */
export function isLinearRealtimeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && (url.hostname === 'sync.linear.app' || url.hostname.endsWith('.linear.app')) && !url.username && !url.password && !url.port;
  } catch { return false; }
}

/** The handshake identity from the stored session headers, or the reason it is missing. */
export function realtimeIdentity(headers = {}, settings = DEFAULT_REALTIME) {
  const userId = headers.user, userAccountId = headers.useraccount;
  const clientVersion = headers['linear-client-version'] || settings.clientVersion || '';
  const clientDatabaseId = headers['linear-client-database-id'];
  if (!headers.cookie) return { reason: 'missing_cookie' };
  if (!SAFE_ID.test(userId ?? '') || !SAFE_ID.test(userAccountId ?? '')) return { reason: 'missing_user_account' };
  if (!SAFE_VERSION.test(clientVersion)) return { reason: 'missing_client_version' };
  if (clientDatabaseId !== undefined && !SAFE_VERSION.test(clientDatabaseId)) return { reason: 'invalid_client_database_id' };
  return { identity: { userId, userAccountId, clientVersion, ...(clientDatabaseId ? { clientDatabaseId } : {}) } };
}

const emptyDoc = doc => !doc || !Array.isArray(doc.content) || doc.content.every(block => block?.type === 'paragraph' && !block.content?.length);

// Buffered deltas confirmed by a snapshot must also start with the snapshot's first
// block markup, so a missed "# " or "- " at the very start cannot slip through.
function leadMatches(doc, raw) {
  const first = doc?.content?.find(block => block?.type !== 'paragraph' || block.content?.length);
  const text = raw.replace(/^\s+/, '');
  if (!first || first.type === 'paragraph') return !/^(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|`{3}|~{3})/.test(text);
  if (first.type === 'heading') return /^#{1,6}\s/.test(text);
  if (first.type === 'bullet_list') return /^[-*+]\s/.test(text);
  if (first.type === 'ordered_list') return /^\d{1,9}[.)]\s/.test(text);
  if (first.type === 'code_block') return /^(?:`{3}|~{3}| {4})/.test(text);
  if (first.type === 'blockquote') return text.startsWith('>');
  return false;
}

/** Text of a snapshot made only of plain paragraphs (no marks, no other nodes), else null. */
function plainSnapshot(doc) {
  if (doc?.type !== 'doc' || !Array.isArray(doc.content)) return null;
  const paragraphs = [];
  for (const block of doc.content) {
    if (block?.type !== 'paragraph') return null;
    let text = '';
    for (const node of block.content ?? []) {
      if (node?.type === 'hard_break') text += '\n';
      else if (node?.type === 'text' && typeof node.text === 'string' && !node.marks?.length) text += node.text;
      else return null;
    }
    paragraphs.push(text);
  }
  return paragraphs.filter(Boolean).join('\n\n');
}

function stepAtStart(steps) {
  const step = Array.isArray(steps) ? steps[0] : null;
  return isObject(step) && /^replace/.test(step.stepType ?? '') && Number.isInteger(step.from) && step.from >= 0 && step.from <= 1 && (step.to ?? step.from) <= 1;
}

function cursorKey(cursor) {
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return { key: 'n' + cursor, order: [cursor, 0] };
  if (typeof cursor === 'string' && cursor.length <= 256) {
    const match = cursor.match(/^(\d{1,15})(?:-(\d{1,15}))?$/);
    return { key: 's' + cursor, ...(match ? { order: [Number(match[1]), Number(match[2] ?? 0)] } : {}) };
  }
  if (cursor === undefined || cursor === null) return null;
  const text = JSON.stringify(cursor);
  return text && text.length <= 512 ? { key: 'j' + text } : null;
}
const earlier = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

function generationOf(message, data) {
  for (const value of [data?.generation, message.generation, message.provenance?.generation]) if (Number.isSafeInteger(value)) return value;
  return null;
}
function provenanceKey(value) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text ? text.slice(0, 256) : null;
}

/**
 * The answer text of one assistant turn as seen on the realtime channel. Parts are
 * kept in the order they first appeared; the emitter walks `sequence()`.
 */
export class TurnStream {
  constructor({ assistantMessageId, scope = 'turn', now = () => performance.now() }) {
    Object.assign(this, { assistantMessageId, scope, now });
    this.parts = new Map();
    this.order = [];
    this.diverged = null;
    this.version = 0;
    this.seen = new Set();
    this.lastCursor = null;
    this.firstAnswerAt = null;
    this.lastAnswerAt = null;
    this.size = 0;
    this.stats = { text_events: 0, delta_events: 0, answer_deltas: 0, reasoning_events: 0, commentary_parts: 0, foreign_parts: 0, duplicates: 0, stale: 0, other_types: 0, invalid: 0, provenance_changes: 0, generation_changes: 0, reopened: 0, unanchored_snapshots: 0 };
  }
  sequence() { return this.order.map(id => this.parts.get(id)); }
  answerParts() { return this.sequence().filter(part => part.ours && part.phase === 'answer'); }
  belongs(id, metadata) {
    const turn = metadata?.turnId;
    if (turn && turn !== this.assistantMessageId) return false;
    const own = id === this.assistantMessageId || id.startsWith(this.assistantMessageId + ':');
    return this.scope === 'turn' ? !turn || turn === this.assistantMessageId || own : turn === this.assistantMessageId || own;
  }
  part(id) {
    let part = this.parts.get(id);
    if (part) return part;
    if (this.parts.size >= MAX_PARTS) { this.diverge('too_many_parts'); return null; }
    part = { id, ours: undefined, phase: undefined, anchored: false, anchor: null, raw: '', pending: '', pendingStart: false, snapshot: null, checkedAt: -Infinity, terminal: false, closed: false, provenance: null, generation: null, deltas: 0 };
    this.parts.set(id, part);
    this.order.push(id);
    return part;
  }
  diverge(reason) { this.diverged ??= reason; this.version++; }
  identify(part, { type, phase, metadata }) {
    const ours = this.belongs(part.id, metadata);
    const value = type === 'text' ? phase ?? null : type;
    if (part.ours !== undefined) {
      if (part.ours !== ours || part.phase !== value) this.diverge('identity_changed');
      return;
    }
    part.ours = ours;
    part.phase = value;
    if (!ours) { this.stats.foreign_parts++; return; }
    if (value !== 'answer') { if (type === 'text') this.stats.commentary_parts++; return; }
    if (part.anchored && part.raw) this.answered();
    else if (!part.anchored && part.pending && part.pendingStart) this.anchor(part, 'step_start', part.pending);
  }
  anchor(part, how, raw) {
    Object.assign(part, { anchored: true, anchor: how, raw, pending: '' });
    if (raw && part.phase === 'answer') this.answered();
  }
  answered() {
    this.firstAnswerAt ??= this.now();
    this.lastAnswerAt = this.now();
  }
  /** Identity for parts whose deltas arrived without a text message, from a GraphQL read. */
  identifyFromRead(parts) {
    let changed = false;
    for (const item of parts ?? []) {
      const part = typeof item?.id === 'string' ? this.parts.get(item.id) : null;
      if (!part || part.ours !== undefined) continue;
      this.identify(part, { type: item.type === 'text' ? 'text' : String(item.type ?? 'unknown'), phase: item.metadata?.phase ?? null, metadata: { turnId: this.assistantMessageId } });
      changed = true;
    }
    if (changed) { this.closeEarlier(); this.version++; }
    return changed;
  }
  closeEarlier() {
    const answers = this.answerParts();
    for (let i = 0; i < answers.length - 1; i++) if (!answers[i].closed && answers.slice(i + 1).some(p => p.raw || p.pending)) answers[i].closed = true;
  }
  /** Applies one streamData message; returns { changed, hint }. */
  applyMessage(message) {
    const items = Array.isArray(message.data) ? message.data : [message.data];
    // Exact resends and cursors that go backwards are dropped as duplicates.
    const cursor = cursorKey(message.cursor);
    if (cursor) {
      const fingerprint = cursor.key + '|' + items.map(item => [item?.type, item?.id, typeof item?.delta === 'string' ? item.delta.length : ''].join(':')).join(',');
      if (this.seen.has(fingerprint) || (cursor.order && this.lastCursor && earlier(cursor.order, this.lastCursor))) { this.stats.duplicates++; return { changed: false, hint: false }; }
      if (this.seen.size < MAX_SEEN) this.seen.add(fingerprint);
      if (cursor.order) this.lastCursor = cursor.order;
    }
    const version = this.version;
    let hint = false;
    for (const item of items) if (this.apply(message, item) === 'hint') hint = true;
    return { changed: this.version !== version, hint };
  }
  apply(message, data) {
    if (!isObject(data) || typeof data.id !== 'string' || !data.id || data.id.length > 256) { this.stats.invalid++; return null; }
    const type = data.type;
    if (type !== 'text' && type !== 'textDelta') {
      if (/^reasoning/i.test(type ?? '')) {
        this.stats.reasoning_events++;
        const part = this.part(data.id);
        if (part && part.ours === undefined) this.identify(part, { type: 'reasoning', metadata: data.metadata });
      } else this.stats.other_types++;
      return null;
    }
    const part = this.part(data.id);
    if (!part) return null;
    const generation = generationOf(message, data);
    if (generation !== null) {
      if (part.generation !== null && generation < part.generation) { this.stats.stale++; return null; }
      if (part.generation !== null && generation > part.generation) {
        this.stats.generation_changes++;
        if (part.raw || part.pending) this.diverge('generation_changed');
      }
      part.generation = generation;
    }
    const provenance = provenanceKey(message.provenance ?? data.provenance);
    if (provenance) {
      if (part.provenance && part.provenance !== provenance) this.stats.provenance_changes++;
      part.provenance ??= provenance;
    }
    return type === 'text' ? this.applyText(part, data) : this.applyDelta(part, data);
  }
  applyText(part, data) {
    this.stats.text_events++;
    if (isObject(data.metadata) && (data.metadata.phase !== undefined || data.metadata.turnId !== undefined)) this.identify(part, { type: 'text', phase: data.metadata.phase ?? null, metadata: data.metadata });
    if (part.ours === false || (part.ours && part.phase !== 'answer')) return null;
    const doc = isObject(data.bodyData) ? data.bodyData : null;
    const terminal = typeof data.status === 'string' && TERMINAL.test(data.status);
    const now = this.now();
    if (!part.anchored) {
      const plain = doc ? plainSnapshot(doc) : '';
      if (!part.pending && emptyDoc(doc)) this.anchor(part, 'empty_snapshot', '');
      else if (!part.pending && plain !== null) this.anchor(part, 'snapshot', plain);
      else if (part.pending && doc && skeleton(richText(doc)) === skeleton(part.pending) && leadMatches(doc, part.pending)) this.anchor(part, 'confirmed', part.pending);
      else this.stats.unanchored_snapshots++;
    } else if (doc && (terminal || now - part.checkedAt >= SNAPSHOT_CHECK_MS)) {
      part.checkedAt = now;
      const seen = skeleton(richText(doc)), have = skeleton(part.raw);
      // A snapshot may lag behind the deltas or run ahead of them; anything else
      // means Linear replaced text this channel already collected.
      if (seen !== have && !have.startsWith(seen) && !seen.startsWith(have)) this.diverge('snapshot_mismatch');
    }
    part.snapshot = { status: typeof data.status === 'string' ? data.status.slice(0, 32) : null };
    if (terminal) part.terminal = part.closed = true;
    this.closeEarlier();
    this.version++;
    return terminal && part.ours && part.phase === 'answer' ? 'hint' : null;
  }
  applyDelta(part, data) {
    this.stats.delta_events++;
    if (typeof data.delta !== 'string') { this.stats.invalid++; return null; }
    if (part.ours === false || (part.ours && part.phase !== 'answer')) return null;
    if (!data.delta) return null;
    let delta = data.delta;
    // Real Linear events can omit the opening ``` from delta while replacing the
    // initial empty paragraph with a code_block. Recover only this unambiguous
    // prefix from the accompanying document step; the language line is already
    // present in delta. Later code blocks and arbitrary edits are never guessed.
    if (!part.raw && !part.pending && !part.deltas) {
      const step = data.steps?.find(s => s.stepType === 'replace' && s.from === 0 && s.to <= 2);
      const block = step?.slice?.content?.[0];
      if (block?.type === 'code_block') {
        const language = block.attrs?.language ?? '';
        if (typeof language === 'string' && ((language && delta === language) || delta.startsWith(language + '\n'))) delta = '```' + delta;
      }
    }
    // A "complete" snapshot followed by more text was not final after all; text for an
    // answer part after a later answer part started cannot be streamed in order.
    if (part.terminal) { part.terminal = false; this.stats.reopened++; }
    if (part.closed) {
      const answers = this.answerParts();
      if (part.ours && answers.slice(answers.indexOf(part) + 1).some(p => p.raw || p.pending)) this.diverge('late_delta');
      else part.closed = false;
    }
    if (part.ours) this.stats.answer_deltas++;
    this.size += delta.length;
    if (part.anchored) {
      part.raw += delta;
      part.deltas++;
      if (part.ours) this.answered();
    } else if (!part.pending && !part.snapshot && stepAtStart(data.steps) && part.ours) {
      this.anchor(part, 'step_start', delta);
    } else {
      if (!part.pending) part.pendingStart = !part.snapshot && stepAtStart(data.steps);
      if (part.pending.length + delta.length > MAX_PENDING) { this.diverge('pending_too_large'); return null; }
      part.pending += delta;
    }
    this.closeEarlier();
    this.version++;
    return null;
  }
}

/**
 * One WebSocket for one request. `start()` connects and authenticates in the
 * background; `watch()` subscribes once Linear accepted the message. Failures
 * never throw into the request; they are reported through `failure`.
 */
export class RealtimeChannel {
  constructor(headers, settings = DEFAULT_REALTIME, { WebSocketImpl = globalThis.WebSocket, timing = null, onUpdate = () => {}, onHint = () => {}, now = () => performance.now() } = {}) {
    this.headers = headers ?? {};
    this.settings = { ...DEFAULT_REALTIME, ...settings };
    Object.assign(this, { WebSocketImpl, timing, onUpdate, onHint, now });
    this.state = 'idle';
    this.failure = null;
    this.socket = null;
    this.subscription = null;
    this.turn = null;
    this.timers = new Set();
    this.counters = { messages: 0, bytes: 0, invalid_json: 0, pings: 0, pongs: 0 };
    this.pingId = 0;
  }
  get healthy() { return this.state === 'subscribed'; }
  get active() { return this.state !== 'failed' && this.state !== 'closed'; }
  /** Answer text arrived within the quiet period: polling can slow down meanwhile. */
  get streaming() { return this.healthy && this.turn?.lastAnswerAt != null && this.now() - this.turn.lastAnswerAt < this.settings.quietMs; }
  timer(callback, ms, repeat = false) {
    const handle = (repeat ? setInterval : setTimeout)(() => { if (!repeat) this.timers.delete(handle); callback(); }, ms);
    handle.unref?.();
    this.timers.add(handle);
    return handle;
  }
  clear(handle) { if (handle) { clearTimeout(handle); clearInterval(handle); this.timers.delete(handle); } }
  mark(name) { this.timing?.mark(name); }
  start() {
    if (this.state !== 'idle') return this;
    const { identity, reason } = realtimeIdentity(this.headers, this.settings);
    if (!identity) return this.fail(reason);
    if (typeof this.WebSocketImpl !== 'function') return this.fail('websocket_unavailable');
    this.identity = identity;
    let url;
    try {
      url = new URL(this.settings.url);
      url.searchParams.set('userId', identity.userId);
      url.searchParams.set('userAccountId', identity.userAccountId);
    } catch { return this.fail('invalid_url'); }
    const headers = { cookie: this.headers.cookie, origin: 'https://linear.app', ...(this.headers['user-agent'] ? { 'user-agent': this.headers['user-agent'] } : {}) };
    this.state = 'connecting';
    this.connectTimer = this.timer(() => this.fail('connect_timeout'), this.settings.connectTimeoutMs);
    let socket;
    try { socket = this.socket = new this.WebSocketImpl(url.href, { headers }); }
    catch { return this.fail('connect_failed'); }
    try { socket.binaryType = 'arraybuffer'; } catch {}
    socket.addEventListener('open', () => { if (this.socket === socket) this.opened(); });
    socket.addEventListener('message', event => { if (this.socket === socket) this.received(event.data); });
    socket.addEventListener('error', () => { if (this.socket === socket) this.fail(this.state === 'connecting' ? 'connect_failed' : 'socket_error'); });
    socket.addEventListener('close', event => { if (this.socket === socket) this.fail(this.state === 'subscribed' ? 'disconnected' : 'closed_before_ready', event?.code); });
    return this;
  }
  send(message) {
    try {
      if (this.socket?.readyState !== 1) return false;
      this.socket.send(JSON.stringify(message));
      return true;
    } catch { this.fail('send_failed'); return false; }
  }
  opened() {
    this.state = 'handshaking';
    const { userId, userAccountId, clientDatabaseId, clientVersion } = this.identity;
    this.send({ cmd: 'hshk', userId, userAccountId, clientType: 'web', ...(clientDatabaseId ? { clientDatabaseId } : {}), protocolVersion: 3, clientVersion, useBinaryProtocol: false, supportsSpectatorMode: true });
    this.alive();
  }
  alive() {
    this.clear(this.idleTimer);
    if (this.active) this.idleTimer = this.timer(() => this.fail('idle_timeout'), this.settings.idleTimeoutMs);
  }
  /** Subscribes to the accepted turn; may be called before the handshake finished. */
  watch({ conversationId, assistantMessageId }) {
    if (!this.active || this.turn) return this;
    const scope = this.settings.subscription === 'conversation' ? 'conversation' : 'turn';
    this.turn = new TurnStream({ assistantMessageId, scope, now: this.now });
    this.subscription = scope === 'turn'
      ? { modelName: 'AiConversationTurn', modelId: assistantMessageId, propertyName: 'parts' }
      : { modelName: 'AiConversation', modelId: conversationId, propertyName: 'parts' };
    if (this.state === 'ready') this.subscribe();
    return this;
  }
  subscribe() {
    if (!this.send({ cmd: 'streamData', action: 'subscribe', ...this.subscription })) return;
    this.state = 'subscribed';
    this.mark('realtime_subscribed');
  }
  received(data) {
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? 0;
    if (size > this.settings.maxMessageBytes) return this.fail('message_too_large');
    this.counters.bytes += size;
    if (this.counters.bytes > this.settings.maxTotalBytes) return this.fail('stream_too_large');
    this.counters.messages++;
    this.alive();
    let text = data;
    if (typeof data !== 'string') {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { return this.fail('binary_protocol'); }
    }
    let message;
    try { message = JSON.parse(text); } catch { this.counters.invalid_json++; return; }
    if (!isObject(message)) return;
    if (message.cmd === 'noauth') return this.fail('noauth');
    if (message.cmd === 'error') return this.fail('server_error');
    if (message.cmd === 'hshk') {
      if (this.state !== 'handshaking') return;
      if (!isObject(message.sync)) return this.fail('handshake_rejected');
      this.clear(this.connectTimer);
      this.state = 'ready';
      this.mark('realtime_ready');
      this.timer(() => { this.counters.pings++; this.send({ cmd: 'ping', id: ++this.pingId }); }, this.settings.pingMs, true);
      if (this.subscription) this.subscribe();
      return;
    }
    if (message.cmd === 'pong') { this.counters.pongs++; return; }
    if (message.cmd !== 'streamData' || this.state !== 'subscribed') return;
    const { modelName, modelId, propertyName = 'parts' } = message;
    if (modelName !== this.subscription.modelName || modelId !== this.subscription.modelId || propertyName !== this.subscription.propertyName) return;
    this.mark('first_stream_event');
    const { changed, hint } = this.turn.applyMessage(message);
    if (this.turn.firstAnswerAt !== null) this.mark('first_answer_delta');
    if (changed) {
      this.quiet();
      this.update();
    }
    if (hint && this.active) this.onHint('final_snapshot');
  }
  // Every change is delivered at once while the text is short. Long replies are
  // delivered in batches (one per coalesce period), so they do not cost a full
  // re-render per tiny delta; the final text never depends on these updates.
  update() {
    if (this.updateTimer) return;
    if (this.turn.size < COALESCE_FROM) return this.deliver();
    const wait = (this.lastUpdate ?? -Infinity) + this.settings.coalesceMs - this.now();
    if (wait <= 0) return this.deliver();
    this.updateTimer = this.timer(() => { this.updateTimer = null; this.deliver(); }, wait);
  }
  deliver() {
    this.lastUpdate = this.now();
    try { if (this.active) this.onUpdate(this.turn); }
    catch { this.fail('consumer_error'); }
  }
  /** After answer text stopped arriving for a moment, let the poller look for completion. */
  quiet() {
    this.clear(this.quietTimer);
    if (this.turn?.lastAnswerAt != null && this.active) this.quietTimer = this.timer(() => this.onHint('quiet'), this.settings.quietMs);
  }
  /** Identity of pending parts, learned from a GraphQL read of the same turn. */
  identify(parts) {
    if (this.turn && this.active && this.turn.identifyFromRead(parts)) this.update();
  }
  fail(reason, code) {
    if (!this.active) return this;
    this.failure = { reason, state: this.state, ...(Number.isInteger(code) ? { code } : {}) };
    this.release('failed');
    this.onHint('realtime_failed');
    return this;
  }
  release(state) {
    const socket = this.socket, subscribed = this.state === 'subscribed';
    this.state = state;
    for (const handle of this.timers) { clearTimeout(handle); clearInterval(handle); }
    this.timers.clear();
    this.socket = null;
    if (!socket) return;
    try {
      if (subscribed && socket.readyState === 1) socket.send(JSON.stringify({ cmd: 'streamData', action: 'unsubscribe', ...this.subscription }));
      if (socket.readyState === 0 || socket.readyState === 1) socket.close(1000);
    } catch {}
  }
  /** Unsubscribes and releases the socket; idempotent. */
  close() {
    if (this.active) this.release('closed');
    return this;
  }
  /** Counters and the fallback reason, without any message content. */
  summary() {
    const turn = this.turn;
    const streamed = Boolean(turn && turn.firstAnswerAt !== null);
    const counters = Object.entries({ ...this.counters, ...turn?.stats }).filter(([, value]) => value);
    return {
      status: this.failure && !streamed ? 'fallback' : streamed ? 'streamed' : this.state === 'idle' ? 'unused' : 'connected',
      ...(this.failure ? { fallback_reason: this.failure.reason, failed_in: this.failure.state } : {}),
      subscription: this.settings.subscription,
      ...Object.fromEntries(counters),
      ...(turn ? { anchors: turn.answerParts().map(p => p.anchor ?? 'none'), ...(turn.diverged ? { diverged: turn.diverged } : {}) } : {}),
    };
  }
}

/**
 * First-occurrence timestamps of one request, in milliseconds after `start()` (the
 * upstream send). Marks made before `start()` are measured from creation.
 */
export function createTiming(now = () => performance.now()) {
  let origin = now();
  const marks = {};
  return {
    start() { if (!('send_start' in marks)) { origin = now(); marks.send_start = 0; } },
    mark(name) { if (!(name in marks)) marks[name] = Math.max(0, Math.round(now() - origin)); },
    has: name => name in marks,
    get: name => marks[name] ?? null,
    snapshot() {
      const { send_start, ...rest } = marks;
      return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key + '_ms', value]));
    },
  };
}

/** Factory used by LinearClient: one channel per streamed chat call, or null when disabled. */
export function realtimeFactory(settings, { WebSocketImpl } = {}) {
  const merged = { ...DEFAULT_REALTIME, ...settings };
  if (merged.mode === 'off') return null;
  const factory = (headers, hooks) => new RealtimeChannel(headers, merged, { ...(WebSocketImpl ? { WebSocketImpl } : {}), ...hooks });
  factory.settings = merged;
  return factory;
}

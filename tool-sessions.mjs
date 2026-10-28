// Tracks which Linear conversation and account produced each client-visible
// assistant reply in a tool loop, so the next request can continue natively.
//
// A session is keyed by the hash of the full client history up to and including
// the gateway's latest assistant reply. Only hashes, IDs and timestamps are
// persisted (.local-runtime/tool-sessions.json); message contents never are.
// Completed replies are cached in memory for duplicate-request protection.

import fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { GatewayError } from './errors.mjs';

const VERSION = 1;

export class ToolSessionStore {
  constructor(runtimeDir, { ttlMs = 24 * 3600 * 1000, maxSessions = 1000, idempotencyMs = 5 * 60 * 1000, maxCached = 100, maxCachedBytes = 32 * 1024 * 1024, maxEntryBytes = 1024 * 1024, now = Date.now, onError = () => {} } = {}) {
    this.file = runtimeDir ? new URL('tool-sessions.json', runtimeDir) : null;
    Object.assign(this, { ttlMs, maxSessions, idempotencyMs, maxCached, maxCachedBytes, maxEntryBytes, now, onError });
    this.cachedBytes = 0;
    this.sessions = new Map();
    this.byPrefix = new Map();
    this.byConversation = new Map();
    this.inflight = new Set();
    this.cache = new Map();
    this.dispatched = new Map();
    this.writer = Promise.resolve();
    this.unavailable = false;
  }
  async initialize() {
    if (!this.file) return;
    let state;
    try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      // A damaged cache must not block chat. Keep it for inspection instead of overwriting it.
      await fs.copyFile(this.file, new URL(this.file.href + '.corrupt-' + Date.now())).catch(() => {});
      this.unavailable = true;
      this.onError({ code: 'tool_session_store_reset', status: 500 });
      return;
    }
    if (state?.version !== VERSION || !Array.isArray(state.sessions)) { this.unavailable = true; return; }
    for (const entry of state.dispatched ?? []) if (/^[a-f0-9]{64}$/.test(entry?.key) && Number.isFinite(entry.expires) && entry.expires > this.now()) this.dispatched.set(entry.key, entry.expires);
    for (const saved of state.sessions) {
      if (typeof saved?.id !== 'string' || typeof saved.prefixHash !== 'string' || typeof saved.conversationId !== 'string') continue;
      this.index({ ...saved, busy: false, droppedCalls: [] });
    }
    this.prune();
  }
  index(session) {
    this.sessions.set(session.id, session);
    this.byPrefix.set(session.prefixHash, session.id);
    this.byConversation.set(session.conversationId, session.id);
  }
  forget(session) {
    this.sessions.delete(session.id);
    if (this.byPrefix.get(session.prefixHash) === session.id) this.byPrefix.delete(session.prefixHash);
    if (this.byConversation.get(session.conversationId) === session.id) this.byConversation.delete(session.conversationId);
  }
  expired(session) { return this.now() - Date.parse(session.updatedAt) > this.ttlMs; }
  prune() {
    for (const session of [...this.sessions.values()]) if (this.expired(session) && !session.busy) this.forget(session);
    const ordered = [...this.sessions.values()].filter(s => !s.busy).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    while (this.sessions.size > this.maxSessions && ordered.length) this.forget(ordered.shift());
    for (const [key, entry] of this.cache) if (entry.expires <= this.now()) this.drop(key);
    for (const [key, expires] of this.dispatched) if (expires <= this.now()) this.dispatched.delete(key);
  }
  drop(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cachedBytes -= entry.size;
    this.cache.delete(key);
  }
  live(id) {
    const session = id && this.sessions.get(id);
    if (!session || session.dirty || this.expired(session)) return null;
    return session;
  }
  /** The session whose latest reply is exactly the client's history prefix. */
  findByPrefix(prefixHash) { return this.live(this.byPrefix.get(prefixHash)); }
  findByConversation(conversationId) { return this.live(this.byConversation.get(conversationId)); }
  claim(session) {
    if (session.busy) return false;
    session.busy = true;
    return true;
  }
  release(session) { if (session) session.busy = false; }
  markDirty(session) {
    if (!session) return;
    session.dirty = true;
    session.busy = false;
    this.forget(session);
    this.persist();
  }
  /** Records the reply the client now holds; returns the session. */
  record({ session, accountId, conversationId, prefixHash, toolsHash, protocolSent, toolCallIds, droppedCalls, clientScope = 'legacy' }) {
    const stamp = new Date(this.now()).toISOString();
    if (session) {
      if (this.byPrefix.get(session.prefixHash) === session.id) this.byPrefix.delete(session.prefixHash);
      Object.assign(session, { accountId, conversationId, prefixHash, toolsHash, protocolSent: Boolean(protocolSent || session.protocolSent), toolCallIds, droppedCalls, clientScope, updatedAt: stamp, turns: (session.turns ?? 0) + 1, busy: false });
    } else {
      session = { id: 'ts-' + randomBytes(10).toString('hex'), accountId, conversationId, prefixHash, toolsHash, protocolSent: Boolean(protocolSent), toolCallIds, droppedCalls, clientScope, createdAt: stamp, updatedAt: stamp, turns: 1, dirty: false, busy: false };
    }
    this.index(session);
    this.prune();
    this.persist();
    return session;
  }
  beginRequest(key) {
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }
  endRequest(key) { this.inflight.delete(key); }
  assertReplaySafe(key) {
    if (this.unavailable) throw new GatewayError(503, 'tool_session_store_unavailable', 'Tool request safety state is damaged. Restore its backup before using tools.');
    if ((this.dispatched.get(key) ?? 0) > this.now()) throw new GatewayError(409, 'tool_request_already_dispatched', 'This tool request was already sent to Linear and its reply cannot safely be replayed. Check the previous result before continuing; do not execute any tool twice.');
  }
  async markDispatched(key) {
    this.prune();
    if (!this.dispatched.has(key) && this.dispatched.size >= 5000) throw new GatewayError(503, 'tool_request_ledger_full', 'The tool request safety ledger is full. Wait for old entries to expire.');
    this.dispatched.set(key, this.now() + this.ttlMs);
    await this.persist(true);
  }
  async clearDispatched(key) { this.dispatched.delete(key); await this.persist(true); }
  cached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.drop(key); return null; }
    return entry.payload;
  }
  /** Keeps a completed reply in memory only, bounded by count, bytes and age. */
  remember(key, payload, size = 0) {
    if (!this.idempotencyMs || size > this.maxEntryBytes) return;
    this.drop(key);
    this.cache.set(key, { expires: this.now() + this.idempotencyMs, payload, size });
    this.cachedBytes += size;
    while (this.cache.size > this.maxCached || this.cachedBytes > this.maxCachedBytes) this.drop(this.cache.keys().next().value);
  }
  snapshot() {
    return [...this.sessions.values()].filter(s => !s.dirty).map(({ id, accountId, conversationId, prefixHash, toolsHash, protocolSent, toolCallIds, clientScope, createdAt, updatedAt, turns }) => ({ id, accountId, conversationId, prefixHash, toolsHash, protocolSent, toolCallIds, clientScope, createdAt, updatedAt, turns }));
  }
  persist(strict = false) {
    if (!this.file) return Promise.resolve();
    const work = async () => {
      const sessions = this.snapshot();
      await fs.mkdir(new URL('./', this.file), { recursive: true });
      const temporary = new URL(this.file.href + '.tmp-' + randomUUID());
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: VERSION, sessions, dispatched: [...this.dispatched].map(([key, expires]) => ({ key, expires })) }, null, 2), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    };
    const task = this.writer.then(work, work);
    this.writer = task.catch(() => this.onError({ code: 'tool_session_store_unavailable', status: 503 }));
    return strict ? task.catch(() => { throw new GatewayError(503, 'tool_session_store_unavailable', 'Cannot persist tool request safety state.'); }) : this.writer;
  }
  async flush() { await this.writer; }
}

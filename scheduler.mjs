// Bounded concurrency: a global FIFO limit, a per-account limit, and the
// existing cap on outstanding (running + waiting) requests.

import { GatewayError } from './errors.mjs';

function abortable(signal, register, unregister) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { unregister(waiter); reject(signal.reason); };
    const waiter = value => { signal?.removeEventListener('abort', onAbort); resolve(value); };
    signal?.addEventListener('abort', onAbort, { once: true });
    register(waiter);
  });
}

export class Scheduler {
  constructor({ maxConcurrency = 4, accountConcurrency = 1, maxQueue = 8 } = {}) {
    for (const [name, value] of Object.entries({ maxConcurrency, accountConcurrency, maxQueue })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid scheduler ${name}`);
    }
    Object.assign(this, { maxConcurrency, accountConcurrency, maxQueue });
    this.outstanding = 0;
    this.running = 0;
    this.globalWaiters = [];
    this.accounts = new Map();
    this.releaseWaiters = new Set();
    this.generation = 0;
    this.lock = Promise.resolve();
  }
  /** Reserves a place among outstanding requests or fails fast with 429. */
  admit() {
    if (this.outstanding >= this.maxQueue) throw new GatewayError(429, 'queue_full', 'The local Linear request queue is full.');
    this.outstanding++;
    let released = false;
    return { release: () => { if (!released) { released = true; this.outstanding--; } } };
  }
  async acquireGlobal(signal) {
    if (this.running < this.maxConcurrency && !this.globalWaiters.length) this.running++;
    else await abortable(signal, waiter => this.globalWaiters.push(waiter), waiter => { this.globalWaiters = this.globalWaiters.filter(w => w !== waiter); });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.globalWaiters.shift();
      if (next) next(); else this.running--;
    };
  }
  active(key) { return this.accounts.get(key) ?? 0; }
  /** Takes a per-account slot if one is free; returns its release function or null. */
  tryAccount(key) {
    if (this.active(key) >= this.accountConcurrency) return null;
    this.accounts.set(key, this.active(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.active(key) - 1;
      if (left > 0) this.accounts.set(key, left); else this.accounts.delete(key);
      this.generation++;
      for (const waiter of [...this.releaseWaiters]) { this.releaseWaiters.delete(waiter); waiter(); }
    };
  }
  /** Resolves once any account slot has been released after `generation` was read. */
  waitForRelease(generation, signal) {
    if (this.generation !== generation) return Promise.resolve();
    return abortable(signal, waiter => this.releaseWaiters.add(waiter), waiter => this.releaseWaiters.delete(waiter));
  }
  /** Serializes account selection so rotation order and slot accounting stay consistent. */
  exclusive(work) {
    const task = this.lock.then(work, work);
    this.lock = task.catch(() => {});
    return task;
  }
  snapshot() {
    return { outstanding: this.outstanding, running: this.running, waiting: this.globalWaiters.length, max_concurrency: this.maxConcurrency, account_concurrency: this.accountConcurrency, max_queue: this.maxQueue, busy_accounts: this.accounts.size };
  }
}

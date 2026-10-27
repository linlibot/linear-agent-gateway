import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { GatewayError, MODEL } from './upstream.mjs';

export const DEFAULT_ROUTING_POLICY = Object.freeze({ strategy: 'round_robin', failover_enabled: true, max_attempts: 3, cooldown_seconds: 60 });
const RETRYABLE = new Set(['linear_session_expired', 'linear_rate_limit']);
const UPSTREAM_FAILURES = new Set([...RETRYABLE, 'linear_agent_error', 'linear_network_error', 'linear_upstream_error']);
export const canFailOver = error => RETRYABLE.has(error?.code);
const failureApplies = (account, health) => health.credential_updated_at === account.updatedAt && !(account.lastCheck?.status === 'valid' && Date.parse(account.lastCheck.checkedAt) > Date.parse(health.last_failure_at ?? ''));

function validatePolicy(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !Object.hasOwn(DEFAULT_ROUTING_POLICY, k))) throw new GatewayError(400, 'invalid_routing_policy', 'Unknown routing policy field.');
  if (patch.strategy !== undefined && !['fixed', 'round_robin'].includes(patch.strategy)) throw new GatewayError(400, 'invalid_routing_policy', 'strategy must be fixed or round_robin.');
  if (patch.failover_enabled !== undefined && typeof patch.failover_enabled !== 'boolean') throw new GatewayError(400, 'invalid_routing_policy', 'failover_enabled must be a boolean.');
  for (const [key, maximum] of [['max_attempts', 5], ['cooldown_seconds', 3600]]) {
    if (patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || patch[key] < 1 || patch[key] > maximum)) throw new GatewayError(400, 'invalid_routing_policy', key + ' is outside its allowed range.');
  }
}

export class AccountRouter {
  constructor(accounts, { modelsProvider, now = Date.now } = {}) {
    this.accounts = accounts;
    this.modelsProvider = modelsProvider;
    this.now = now;
    this.file = new URL('routing.json', accounts.runtimeDir);
    this.writer = Promise.resolve();
  }
  write(work) {
    const task = this.writer.then(work, work);
    this.writer = task.catch(() => {});
    return task;
  }
  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.disabled_account_ids) || !state.health || typeof state.health !== 'object' || Array.isArray(state.health)) throw new Error('Invalid state.');
      validatePolicy(state.policy);
      if (Object.keys(state.policy).length !== Object.keys(DEFAULT_ROUTING_POLICY).length) throw new Error('Incomplete policy.');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, policy: { ...DEFAULT_ROUTING_POLICY }, last_account_id: null, disabled_account_ids: [], health: {} };
      throw new GatewayError(503, 'routing_store_unavailable', 'Cannot read the local routing policy.');
    }
  }
  async save(state) {
    await fs.mkdir(new URL('./', this.file), { recursive: true });
    const temporary = new URL(this.file.href + '.tmp-' + randomUUID());
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async initialize() { await this.write(async () => this.save(await this.read())); }
  view(account, state) {
    const h = state.health[account.id] ?? {};
    const refreshed = !failureApplies(account, h);
    const enabled = !state.disabled_account_ids.includes(account.id);
    const blocked = account.lastCheck?.status === 'invalid' || (!refreshed && h.blocked === true);
    const cooldown = !refreshed && Date.parse(h.cooldown_until ?? '') > this.now() ? h.cooldown_until : null;
    return { enabled, status: !enabled ? 'disabled' : blocked ? 'needs_login' : cooldown ? 'cooldown' : 'ready', cooldown_until: cooldown,
      attempts: h.attempts ?? 0, successes: h.successes ?? 0, failures: h.failures ?? 0, last_error_code: h.last_error_code ?? null, last_used_at: h.last_used_at ?? null };
  }
  async status() {
    const state = await this.read(), { accounts } = await this.accounts.state();
    return { policy: state.policy, accounts: accounts.map(a => ({ id: a.id, ...this.view(a, state) })) };
  }
  async setPolicy(patch) {
    validatePolicy(patch);
    await this.write(async () => { const state = await this.read(); state.policy = { ...state.policy, ...patch }; await this.save(state); });
    return this.status();
  }
  async setEnabled(id, enabled) {
    await this.accounts.get(id);
    if (typeof enabled !== 'boolean') throw new GatewayError(400, 'invalid_routing_policy', 'enabled must be a boolean.');
    await this.write(async () => {
      const state = await this.read();
      state.disabled_account_ids = state.disabled_account_ids.filter(v => v !== id);
      if (!enabled) state.disabled_account_ids.push(id);
      await this.save(state);
    });
    return this.status();
  }
  async clearCooldown(id) {
    await this.accounts.get(id);
    await this.write(async () => { const state = await this.read(); if (state.health[id]) state.health[id].cooldown_until = null; await this.save(state); });
    return this.status();
  }
  async models(accountId) {
    if (accountId !== undefined) { await this.accounts.get(accountId); return this.modelsProvider(accountId); }
    const state = await this.read(), store = await this.accounts.state();
    if (state.policy.strategy === 'fixed') return this.modelsProvider(store.defaultAccountId ?? undefined);
    const pool = store.accounts.filter(a => !state.disabled_account_ids.includes(a.id));
    const catalogs = await Promise.all(pool.map(a => this.modelsProvider(a.id)));
    const union = new Map(catalogs.flat().map(m => [m.id, m]));
    if (!union.size) return (await this.modelsProvider(store.defaultAccountId ?? undefined)).filter(m => m.id === MODEL);
    return [...union.values()];
  }
  async plan({ accountId, conversationId, requestedModel }) {
    const state = await this.read();
    if (accountId !== undefined || conversationId !== undefined) {
      const account = await this.accounts.resolve({ accountId, conversationId });
      return { accounts: [account], strategy: conversationId ? 'conversation' : 'explicit', failover_enabled: false };
    }
    const store = await this.accounts.state(), all = store.accounts;
    let ordered;
    if (state.policy.strategy === 'round_robin') {
      const index = all.findIndex(a => a.id === state.last_account_id), start = (index + 1) % Math.max(1, all.length);
      ordered = [...all.slice(start), ...all.slice(0, start)];
    } else {
      ordered = [...all.filter(a => a.id === store.defaultAccountId), ...all.filter(a => a.id !== store.defaultAccountId)];
      if (!state.policy.failover_enabled) ordered = ordered.filter(a => a.id === store.defaultAccountId);
    }
    const ready = ordered.filter(a => this.view(a, state).status === 'ready');
    const supported = await Promise.all(ready.map(async a => ({ account: a, models: await this.modelsProvider(a.id) })));
    const available = supported.filter(v => v.models.some(m => m.id === requestedModel)).map(v => v.account);
    if (!available.length) throw new GatewayError(503, 'no_available_accounts', 'No enabled, ready account has a successful test for this model. Check credentials, cooldowns and per-account model tests.');
    return { accounts: available.slice(0, state.policy.failover_enabled ? state.policy.max_attempts : 1), strategy: state.policy.strategy, failover_enabled: state.policy.failover_enabled };
  }
  async recordAttempt(account, { advanceCursor = true } = {}) {
    await this.write(async () => {
      const state = await this.read(), h = state.health[account.id] ?? {};
      if (advanceCursor) state.last_account_id = account.id;
      state.health[account.id] = { ...h, attempts: (h.attempts ?? 0) + 1, last_used_at: new Date(this.now()).toISOString() };
      await this.save(state);
    });
  }
  async recordSuccess(account) {
    await this.write(async () => {
      const state = await this.read(), h = state.health[account.id] ?? {};
      state.health[account.id] = { ...h, successes: (h.successes ?? 0) + 1, blocked: false, cooldown_until: null, credential_updated_at: account.updatedAt };
      await this.save(state);
    });
  }
  async recordFailure(account, error) {
    if (!UPSTREAM_FAILURES.has(error?.code)) return;
    const current = await this.accounts.get(account.id);
    if (current.updatedAt !== account.updatedAt || current.session.headers.cookie !== account.session.headers.cookie) return;
    await this.write(async () => {
      const state = await this.read(), h = state.health[account.id] ?? {};
      const failedAt = new Date(this.now()).toISOString();
      const currentFailure = failureApplies(account, h);
      state.health[account.id] = { ...h, failures: (h.failures ?? 0) + 1, last_error_code: error.code, last_failure_at: failedAt, credential_updated_at: account.updatedAt,
        blocked: error.code === 'linear_session_expired' || (currentFailure && h.blocked === true),
        cooldown_until: error.code === 'linear_rate_limit' ? new Date(this.now() + state.policy.cooldown_seconds * 1000).toISOString() : currentFailure ? h.cooldown_until ?? null : null };
      await this.save(state);
    });
  }
}

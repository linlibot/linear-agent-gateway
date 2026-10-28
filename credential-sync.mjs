import fs from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GatewayError } from './upstream.mjs';
import { accountIdFor, sessionFromCredentials } from './accounts.mjs';

export const isExtensionOrigin = origin => typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = (input, allowed) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw new GatewayError(400, 'invalid_sync_request', 'Invalid credential sync request fields.');
};
const denied = () => new GatewayError(401, 'invalid_sync_token', 'Credential sync authorization is invalid or revoked.');

export class CredentialSync {
  constructor(runtimeDir, accounts, { now = Date.now } = {}) {
    Object.assign(this, { accounts, now });
    this.file = new URL('credential-sync.json', runtimeDir);
    this.writer = Promise.resolve(); this.failures = new Map(); this.inFlight = new Set();
  }
  write(work) { const result = this.writer.then(work, work); this.writer = result.catch(() => {}); return result; }
  async read(allowMissing = false) {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.pairings) || !Array.isArray(state.grants) ||
        !state.pairings.every(p => /^[a-f0-9]{64}$/.test(p.digest) && /^acct-[a-f0-9]{20}$/.test(p.account_id) && Number.isSafeInteger(p.expires_at)) ||
        !state.grants.every(g => /^sync-[a-f0-9]{20}$/.test(g.id) && /^[a-f0-9]{64}$/.test(g.digest) && /^acct-[a-f0-9]{20}$/.test(g.account_id) && isExtensionOrigin(g.origin) && typeof g.enabled === 'boolean')) throw new Error();
      return state;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return { version: 1, pairings: [], grants: [] };
      throw new GatewayError(503, 'sync_store_unavailable', 'Cannot read credential sync authorization data.');
    }
  }
  async save(state) {
    const temporary = new URL(this.file.href + '.tmp-' + randomUUID());
    try {
      await fs.mkdir(new URL('./', this.file), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch { throw new GatewayError(503, 'sync_store_unavailable', 'Cannot save credential sync authorization data.'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  initialize() { return this.write(async () => this.save(await this.read(true))); }
  publicGrant(g) {
    const { id, account_id, origin, enabled, created_at, last_attempt_at, last_synced_at, last_error_code } = g;
    return { id, account_id, origin, enabled, created_at, last_attempt_at: last_attempt_at ?? null, last_synced_at: last_synced_at ?? null, last_error_code: last_error_code ?? null };
  }
  async list(accountId) {
    await this.writer;
    const state = await this.read();
    return { data: state.grants.filter(g => !accountId || g.account_id === accountId).map(g => this.publicGrant(g)), pending_expires_at: Math.max(0, ...state.pairings.filter(p => (!accountId || p.account_id === accountId) && p.expires_at > this.now()).map(p => p.expires_at)) || null };
  }
  async createPairing(accountId, input) {
    fields(input, []); await this.accounts.get(accountId);
    const code = 'lgp-' + randomBytes(32).toString('hex');
    return this.write(async () => {
      const state = await this.read();
      state.pairings = state.pairings.filter(p => p.expires_at > this.now() && p.account_id !== accountId);
      if (state.pairings.length >= 100) throw new GatewayError(429, 'sync_pairing_limit', 'Too many pending pairings.');
      const expires_at = this.now() + 10 * 60 * 1000;
      state.pairings.push({ digest: hash(code), account_id: accountId, expires_at });
      await this.save(state);
      return { pairing_code: code, expires_at, account_id: accountId };
    });
  }
  async pair(input, origin, ip = 'unknown') {
    fields(input, ['pairing_code', 'user_id', 'organization_id']);
    if (!isExtensionOrigin(origin)) throw new GatewayError(403, 'invalid_sync_origin', 'Credential sync requires a browser extension origin.');
    for (const [key, value] of this.failures) if (value.until <= this.now()) this.failures.delete(key);
    if ((this.failures.get(ip)?.count ?? 0) >= 20 || (!this.failures.has(ip) && this.failures.size >= 1000)) throw new GatewayError(429, 'sync_pairing_rate_limited', 'Too many invalid pairing attempts. Try again later.');
    if (typeof input.pairing_code !== 'string' || !/^lgp-[a-f0-9]{64}$/.test(input.pairing_code) || typeof input.user_id !== 'string' || typeof input.organization_id !== 'string') throw denied();
    return this.write(async () => {
      const state = await this.read(), digest = hash(input.pairing_code);
      const pairing = state.pairings.find(p => p.digest === digest && p.expires_at > this.now());
      if (!pairing) {
        const entry = this.failures.get(ip) ?? { count: 0, until: this.now() + 15 * 60 * 1000 }; entry.count++; this.failures.set(ip, entry); throw denied();
      }
      const account = await this.accounts.get(pairing.account_id);
      if (account.session.headers.user !== input.user_id || account.session.headers.organization !== input.organization_id) throw new GatewayError(409, 'sync_identity_mismatch', 'The selected browser account does not match this pairing.');
      if (state.grants.length >= 1000) throw new GatewayError(429, 'sync_grant_limit', 'The credential sync grant limit has been reached.');
      const token = 'lgs-' + randomBytes(32).toString('hex');
      const grant = { id: 'sync-' + randomBytes(10).toString('hex'), account_id: account.id, digest: hash(token), origin, enabled: true, created_at: new Date(this.now()).toISOString() };
      state.pairings = state.pairings.filter(p => p.digest !== digest); state.grants.push(grant); await this.save(state);
      this.failures.delete(ip);
      return { sync_token: token, grant_id: grant.id, account: { id: account.id, label: account.label, user_id: input.user_id, organization_id: input.organization_id }, interval_minutes: 15 };
    });
  }
  grant(state, token, origin) {
    if (typeof token !== 'string' || !/^lgs-[a-f0-9]{64}$/.test(token)) throw denied();
    const digest = hash(token), grant = state.grants.find(g => g.digest === digest && g.origin === origin && g.enabled);
    if (!grant) throw denied();
    return grant;
  }
  async receive(input, token, origin) {
    fields(input, ['credential']);
    const state = await this.read(), grant = this.grant(state, token, origin), credential = sessionFromCredentials(input.credential);
    if (accountIdFor(credential) !== grant.account_id) throw new GatewayError(409, 'sync_identity_mismatch', 'A sync token may update only its bound account.');
    if (this.inFlight.has(grant.id) || this.inFlight.size >= 4) throw new GatewayError(429, 'sync_busy', 'A credential check is already running.');
    this.inFlight.add(grant.id);
    try {
      await this.write(async () => {
        const latest = await this.read(), current = this.grant(latest, token, origin);
        if (current.last_attempt_at && this.now() - Date.parse(current.last_attempt_at) < 30000) throw new GatewayError(429, 'sync_rate_limited', 'Wait at least 30 seconds between credential updates.');
        current.last_attempt_at = new Date(this.now()).toISOString(); await this.save(latest);
      });
      let account;
      try { account = await this.accounts.refresh(grant.account_id, credential); }
      catch (error) {
        await this.write(async () => { const latest = await this.read(), current = latest.grants.find(g => g.id === grant.id); if (current) { current.last_error_code = ['linear_session_expired', 'sync_identity_mismatch', 'sync_credential_changed', 'linear_rate_limit'].includes(error.code) ? error.code : 'sync_validation_failed'; await this.save(latest); } });
        throw error;
      }
      await this.write(async () => { const latest = await this.read(), current = latest.grants.find(g => g.id === grant.id); if (current) { current.last_synced_at = new Date(this.now()).toISOString(); current.last_error_code = null; await this.save(latest); } });
      return { account_id: account.id, synced_at: new Date(this.now()).toISOString(), status: 'valid' };
    } finally { this.inFlight.delete(grant.id); }
  }
  async revoke(accountId, input) {
    fields(input, ['sync_id']); await this.accounts.get(accountId);
    return this.write(async () => {
      const state = await this.read(), grant = state.grants.find(g => g.id === input.sync_id && g.account_id === accountId);
      if (!grant) throw new GatewayError(404, 'sync_grant_not_found', 'Credential sync grant not found.');
      grant.enabled = false; await this.save(state); return this.publicGrant(grant);
    });
  }
  async revokeToken(token, origin) {
    return this.write(async () => { const state = await this.read(), grant = this.grant(state, token, origin); grant.enabled = false; await this.save(state); return { revoked: true }; });
  }
}

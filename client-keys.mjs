import fs from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GatewayError } from './upstream.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
const invalid = message => new GatewayError(400, 'invalid_client_key', message);

export class ClientKeyStore {
  constructor(runtimeDir, { adminKey } = {}) {
    this.file = new URL('client-keys.json', runtimeDir);
    this.adminDigest = adminKey === undefined ? null : digest(adminKey);
    this.writer = Promise.resolve();
  }
  write(work) {
    const pending = this.writer.then(work, work);
    this.writer = pending.catch(() => {});
    return pending;
  }
  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.keys) || !state.keys.every(k => /^key-[a-f0-9]{20}$/.test(k.id) && /^[a-f0-9]{64}$/.test(k.digest) && typeof k.name === 'string' && typeof k.enabled === 'boolean' && [k.requests, k.successes, k.failures].every(n => Number.isSafeInteger(n) && n >= 0))) throw new Error('Invalid key store.');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, keys: [] };
      throw new GatewayError(503, 'key_store_unavailable', 'Cannot read the local client key store.');
    }
  }
  async save(state) {
    const temporary = new URL(this.file.href + '.tmp-' + randomUUID());
    try {
      await fs.mkdir(new URL('./', this.file), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch {
      throw new GatewayError(503, 'key_store_unavailable', 'Cannot save the local client key store.');
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async initialize() { await this.write(async () => this.save(await this.read())); }
  public(key) {
    const { id, name, enabled, created_at, updated_at, last_used_at, requests, successes, failures } = key;
    return { id, name, enabled, created_at, updated_at, last_used_at, requests, successes, failures };
  }
  async list() { await this.writer; return { object: 'list', data: (await this.read()).keys.map(key => this.public(key)) }; }
  async create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['name', 'key'].includes(k))) throw invalid('Only name and an optional custom key can be supplied.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw invalid('A key name between 1 and 80 characters is required.');
    const token = input.key === undefined ? 'lgc-' + randomBytes(32).toString('hex') : input.key;
    if (!validToken(token)) throw invalid('A custom key must contain 32–256 letters, numbers, underscores or hyphens.');
    const hashed = digest(token);
    if (hashed === this.adminDigest) throw invalid('The administrator key cannot be reused as a client key.');
    return this.write(async () => {
      const state = await this.read();
      if (state.keys.some(k => k.digest === hashed)) throw new GatewayError(409, 'duplicate_client_key', 'This client key already exists.');
      if (state.keys.length >= 1000) throw invalid('The client key limit has been reached.');
      const stamp = new Date().toISOString();
      const key = { id: 'key-' + randomBytes(10).toString('hex'), name: input.name.trim(), digest: hashed, enabled: true, created_at: stamp, updated_at: stamp, last_used_at: null, requests: 0, successes: 0, failures: 0 };
      state.keys.push(key);
      await this.save(state);
      return { object: 'client_key', data: this.public(key), api_key: token };
    });
  }
  async authenticate(token) {
    if (!validToken(token)) return null;
    const hashed = digest(token), key = (await this.read()).keys.find(k => k.digest === hashed && k.enabled);
    return key ? this.public(key) : null;
  }
  async setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw invalid('enabled must be a boolean.');
    return this.write(async () => {
      const state = await this.read(), key = state.keys.find(k => k.id === id);
      if (!key) throw new GatewayError(404, 'client_key_not_found', 'Client key not found.');
      key.enabled = enabled;
      key.updated_at = new Date().toISOString();
      await this.save(state);
      return { data: this.public(key) };
    });
  }
  async begin(id) {
    await this.write(async () => {
      const state = await this.read(), key = state.keys.find(k => k.id === id);
      if (!key?.enabled) throw new GatewayError(401, 'invalid_api_key', 'This client key is disabled or no longer exists.');
      key.requests++;
      key.last_used_at = new Date().toISOString();
      await this.save(state);
    });
  }
  async finish(id, success) {
    await this.write(async () => {
      const state = await this.read(), key = state.keys.find(k => k.id === id);
      if (!key) return;
      key[success ? 'successes' : 'failures']++;
      await this.save(state);
    });
  }
}

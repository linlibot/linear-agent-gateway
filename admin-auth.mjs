import fs from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { GatewayError } from './upstream.mjs';

const derive = promisify(scrypt);
const HASH_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'linear_admin_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const csrfFor = token => createHmac('sha256', token).update('linear-admin-csrf-v1').digest('hex');
const invalid = message => new GatewayError(400, 'invalid_admin_credentials', message);
function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128) throw invalid('Password must contain 15–128 characters. Spaces and Unicode are supported.');
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw invalid('Invalid administrator request fields.');
}

export class AdminAuth {
  constructor(runtimeDir, { bootstrapKey, publicOrigin, now = Date.now } = {}) {
    this.file = new URL('admin-auth.json', runtimeDir);
    this.bootstrapKey = bootstrapKey;
    this.now = now;
    this.writer = Promise.resolve();
    this.failures = new Map();
    this.hashing = 0;
    this.origin = null;
    if (publicOrigin) {
      const url = new URL(publicOrigin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid LINEAR_PUBLIC_URL: use an HTTP(S) origin without a path.');
      this.origin = url.origin;
    }
  }
  write(work) {
    const task = this.writer.then(work, work);
    this.writer = task.catch(() => {});
    return task;
  }
  async read(allowMissing = false) {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const c = state.credential;
      if (state.version !== 1 || !Array.isArray(state.sessions) || (c !== null && (!c || typeof c.username !== 'string' || !/^[a-f0-9]{32}$/.test(c.salt) || !/^[a-f0-9]{128}$/.test(c.hash))) || !state.sessions.every(s => /^[a-f0-9]{64}$/.test(s.digest) && Number.isSafeInteger(s.expires_at)) || (!c && state.sessions.length)) throw new Error('Invalid administrator store.');
      return state;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return { version: 1, credential: null, sessions: [] };
      throw new GatewayError(503, 'admin_auth_unavailable', 'Cannot read administrator authentication data.');
    }
  }
  async save(state) {
    const temporary = new URL(this.file.href + '.tmp-' + randomUUID());
    try {
      await fs.mkdir(new URL('./', this.file), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch { throw new GatewayError(503, 'admin_auth_unavailable', 'Cannot save administrator authentication data.'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async initialize() { await this.write(async () => this.save(await this.read(true))); }
  async configured() { return Boolean((await this.read()).credential); }
  checkLimit(ip) {
    for (const [key, entry] of this.failures) if (entry.until <= this.now()) this.failures.delete(key);
    const entry = this.failures.get(ip);
    if (entry?.count >= 5 || (!entry && this.failures.size >= 1000)) {
      const error = new GatewayError(429, 'admin_login_rate_limited', 'Too many failed administrator logins. Try again later.');
      error.retryAfter = Math.max(1, Math.ceil(((entry?.until ?? this.now() + WINDOW_MS) - this.now()) / 1000));
      throw error;
    }
  }
  failed(ip) {
    const entry = this.failures.get(ip) ?? { count: 0, until: this.now() + WINDOW_MS };
    entry.count++;
    this.failures.set(ip, entry);
  }
  async passwordHash(password, salt) {
    if (this.hashing >= 2) {
      const error = new GatewayError(429, 'admin_login_busy', 'Administrator authentication is busy. Try again shortly.');
      error.retryAfter = 2;
      throw error;
    }
    this.hashing++;
    try { return (await derive(password, Buffer.from(salt, 'hex'), 64, HASH_OPTIONS)).toString('hex'); }
    finally { this.hashing--; }
  }
  assertMutation(req, session) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new GatewayError(415, 'json_required', 'Administrator requests must use application/json.');
    const site = req.headers['sec-fetch-site'];
    const expected = this.origin ?? `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if ((site && !['same-origin', 'none'].includes(site)) || (req.headers.origin && req.headers.origin !== expected)) throw new GatewayError(403, 'csrf_rejected', 'Cross-origin administrator requests are not allowed.');
    if (session && !same(req.headers['x-csrf-token'], session.csrf_token)) throw new GatewayError(403, 'csrf_rejected', 'A valid administrator CSRF token is required. Refresh the page and try again.');
  }
  cookie(token, req, clear = false) {
    const secure = this.origin?.startsWith('https:') || req.socket.encrypted;
    return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
  }
  newSession(state) {
    const token = randomBytes(32).toString('base64url'), expires = this.now() + SESSION_MS;
    state.sessions = state.sessions.filter(s => s.expires_at > this.now()).slice(-19);
    state.sessions.push({ digest: hash(token), expires_at: expires });
    return { token, username: state.credential.username, expires_at: expires, csrf_token: csrfFor(token) };
  }
  async session(req) {
    const tokens = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '=')).map(s => s.slice(COOKIE.length + 1));
    if (tokens.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(tokens[0])) return null;
    const state = await this.read(), digest = hash(tokens[0]);
    const session = state.sessions.find(s => s.digest === digest && s.expires_at > this.now());
    return state.credential && session ? { username: state.credential.username, expires_at: session.expires_at, csrf_token: csrfFor(tokens[0]), digest } : null;
  }
  async setup(input, ip) {
    fields(input, ['bootstrap_key', 'username', 'password']);
    this.checkLimit(ip);
    if (!same(input.bootstrap_key, this.bootstrapKey)) { this.failed(ip); throw new GatewayError(401, 'invalid_bootstrap_key', 'The initialization key is incorrect.'); }
    if (typeof input.username !== 'string' || !/^[\p{L}\p{N}_.-]{3,64}$/u.test(input.username.trim())) throw invalid('Username must contain 3–64 letters, numbers, underscores, dots or hyphens.');
    validatePassword(input.password);
    return this.write(async () => {
      const state = await this.read();
      if (state.credential) throw new GatewayError(409, 'admin_already_configured', 'Administrator credentials have already been configured.');
      const salt = randomBytes(16).toString('hex');
      state.credential = { username: input.username.trim(), salt, hash: await this.passwordHash(input.password, salt), updated_at: new Date(this.now()).toISOString() };
      const result = this.newSession(state);
      await this.save(state);
      this.failures.delete(ip);
      return result;
    });
  }
  async login(input, ip) {
    fields(input, ['username', 'password']);
    this.checkLimit(ip);
    if (typeof input.username !== 'string' || input.username.length > 128 || typeof input.password !== 'string' || [...input.password].length > 128) throw invalid('Invalid username or password format.');
    const state = await this.read(), c = state.credential;
    if (!c) throw new GatewayError(409, 'admin_setup_required', 'Initialize the administrator account first.');
    const candidate = await this.passwordHash(input.password, c.salt);
    if (!same(input.username.trim().toLowerCase(), c.username.toLowerCase()) || !same(candidate, c.hash)) {
      this.failed(ip);
      throw new GatewayError(401, 'invalid_admin_login', 'Username or password is incorrect.');
    }
    return this.write(async () => {
      const current = await this.read();
      if (current.credential?.hash !== c.hash) throw new GatewayError(401, 'invalid_admin_login', 'Username or password is incorrect.');
      const result = this.newSession(current);
      await this.save(current);
      this.failures.delete(ip);
      return result;
    });
  }
  async logout(session) {
    await this.write(async () => { const state = await this.read(); state.sessions = state.sessions.filter(s => s.digest !== session.digest); await this.save(state); });
  }
  async changePassword(session, input, ip) {
    fields(input, ['current_password', 'new_password']);
    this.checkLimit(ip);
    validatePassword(input.new_password);
    if (typeof input.current_password !== 'string' || [...input.current_password].length > 128) throw invalid('Invalid current password format.');
    const credential = (await this.read()).credential;
    if (!credential || !same(await this.passwordHash(input.current_password, credential.salt), credential.hash)) { this.failed(ip); throw new GatewayError(401, 'invalid_admin_login', 'Current password is incorrect.'); }
    await this.write(async () => {
      const state = await this.read();
      if (state.credential?.hash !== credential.hash || !state.sessions.some(s => s.digest === session.digest && s.expires_at > this.now())) throw new GatewayError(401, 'admin_login_required', 'Sign in again before changing the password.');
      const salt = randomBytes(16).toString('hex');
      state.credential = { ...state.credential, salt, hash: await this.passwordHash(input.new_password, salt), updated_at: new Date(this.now()).toISOString() };
      state.sessions = [];
      await this.save(state);
      this.failures.delete(ip);
    });
  }
}

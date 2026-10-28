import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { AdminAuth } from '../admin-auth.mjs';
import { LOGIN_HTML, SETUP_HTML, SECURITY_HTML } from '../admin-pages.mjs';
import { ACCOUNTS_HTML } from '../accounts-page.mjs';
import { KEYS_HTML } from '../keys-page.mjs';
import { ClientKeyStore } from '../client-keys.mjs';
import { AccountStore } from '../accounts.mjs';
import { AccountRouter } from '../routing.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';
import { openAdminSession } from '../scripts/admin-session.mjs';

const bootstrap = 'TEST_BOOTSTRAP_' + 'a'.repeat(40);
const password = 'A synthetic administrator passphrase!';
const replacement = 'A different synthetic passphrase!';
async function fixture(t, { publicOrigin } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-admin-test-'));
  const runtime = pathToFileURL(directory + path.sep);
  let server, keys;
  t.after(async () => {
    await server?.shutdown();
    await keys?.writer;
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-admin-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  let clock = Date.now();
  const auth = new AdminAuth(runtime, { bootstrapKey: bootstrap, publicOrigin, now: () => clock });
  await auth.initialize();
  const accounts = new AccountStore(runtime); await accounts.initialize();
  await accounts.import({ endpoint: ENDPOINT, headers: { user: 'test-user', organization: 'test-org', cookie: 'SYNTHETIC_COOKIE' } });
  keys = new ClientKeyStore(runtime, { adminKey: bootstrap }); await keys.initialize();
  const modelsProvider = async () => modelEntries();
  const router = new AccountRouter(accounts, { modelsProvider }); await router.initialize();
  let calls = 0;
  server = createGateway({ apiKey: bootstrap, accountStore: accounts, accountRouter: router, clientKeys: keys, adminAuth: auth, modelsProvider, clientFactory: () => ({ chat: async (input, signal, accepted) => { calls++; const id = randomUUID(); await accepted(id); return { text: 'OK', conversationId: id }; } }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, { body, token, cookie, csrf, origin, contentType = 'application/json', headers = {} } = {}) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { 'content-type': contentType, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(origin ? { origin } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function signed(response) {
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf_token };
  }
  const setup = () => request('/auth/setup', { body: { bootstrap_key: bootstrap, username: 'Admin', password } }).then(signed);
  const login = (value = password) => request('/auth/login', { body: { username: 'admin', password: value } }).then(signed);
  const manage = (session, route, body) => request(route, { ...session, body });
  return { auth, keys, request, setup, login, manage, runtime, base, advance: ms => { clock += ms; }, calls: () => calls };
}

test('uninitialized and anonymous users cannot load backend pages or bypass management with the old key', async t => {
  const f = await fixture(t);
  for (const route of ['/keys', '/accounts', '/admin/security', '/admin/capture-extension.zip']) {
    const response = await f.request(route);
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/setup');
  }
  for (const route of ['/v1/keys', '/v1/accounts', '/v1/routing']) assert.equal((await f.request(route, { token: bootstrap })).status, 401);
  assert.equal((await f.request('/auth/setup', { body: { bootstrap_key: 'wrong', username: 'admin', password } })).status, 401);
  const before = await (await f.request('/auth/session')).json();
  assert.deepEqual(before, { configured: false, authenticated: false });
  await f.setup();
  const page = await f.request('/keys');
  assert.equal(page.status, 303); assert(page.headers.get('location').startsWith('/login'));
  assert.equal((await f.request('/v1/keys', { token: bootstrap })).status, 401);
});

test('setup requires a long password, is one-time and stores neither plaintext passwords nor session tokens', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/setup', { body: { bootstrap_key: bootstrap, username: 'admin', password: 'short' } })).status, 400);
  const response = await f.request('/auth/setup', { body: { bootstrap_key: bootstrap, username: 'admin', password } });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=28800/);
  assert(!header.includes('Secure'));
  const session = await response.json();
  const rawToken = header.split(';')[0].split('=')[1];
  const disk = await fs.readFile(f.auth.file, 'utf8');
  assert(!disk.includes(password)); assert(!disk.includes(bootstrap)); assert(!disk.includes(rawToken)); assert(!disk.includes(session.csrf_token));
  assert.equal((await f.request('/auth/setup', { body: { bootstrap_key: bootstrap, username: 'other', password } })).status, 409);
});

test('login rotates cookies and a password session can manage the gateway while client keys retain chat access', async t => {
  const f = await fixture(t), initial = await f.setup(), session = await f.login();
  assert.notEqual(session.cookie, initial.cookie);
  assert.notEqual(session.csrf, initial.csrf);
  assert.equal((await f.request('/keys', session)).status, 200);
  const extension = await f.request('/admin/capture-extension.zip', session);
  assert.equal(extension.status, 200); assert.equal(extension.headers.get('content-type'), 'application/zip');
  assert.equal(Buffer.from(await extension.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  const profile = await (await f.request('/auth/session', session)).json();
  assert.equal(profile.username, 'Admin'); assert.equal(profile.authenticated, true); assert.equal(profile.csrf_token, session.csrf);
  assert(!JSON.stringify(profile).includes('digest'));
  const created = await f.manage(session, '/v1/keys', { name: 'Cherry' });
  assert.equal(created.status, 201);
  const { api_key: token } = await created.json();
  assert.equal((await f.request('/v1/models', { token })).status, 200);
  assert.equal((await f.request('/v1/accounts', { token })).status, 403);
  const body = { model: 'linear-agent', messages: [{ role: 'user', content: '你好' }] };
  assert.equal((await f.request('/v1/chat/completions', { token, body })).status, 200);
  assert.equal(f.calls(), 1);
  assert.equal((await f.request('/v1/chat/completions', { ...session, body })).status, 401);
});

test('CSRF, origin and JSON checks reject forged setup, login and authenticated management mutations', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/setup', { origin: 'https://attacker.invalid', body: { bootstrap_key: bootstrap, username: 'admin', password } })).status, 403);
  const session = await f.setup();
  assert.equal((await f.request('/auth/login', { origin: 'https://attacker.invalid', body: { username: 'admin', password } })).status, 403);
  assert.equal((await f.request('/auth/login', { contentType: 'text/plain', body: { username: 'admin', password } })).status, 415);
  assert.equal((await f.request('/v1/keys', { cookie: session.cookie, body: { name: 'bad' } })).status, 403);
  assert.equal((await f.request('/v1/keys', { ...session, origin: 'https://attacker.invalid', body: { name: 'bad' } })).status, 403);
  assert.equal((await f.request('/auth/logout', { ...session, csrf: 'wrong', body: {} })).status, 403);
  assert.equal((await f.keys.list()).data.length, 0);
  assert.equal((await f.manage(session, '/v1/routing', { max_attempts: 2 })).status, 200);
});

test('logout invalidates the server session and sessions expire after eight hours', async t => {
  const f = await fixture(t), session = await f.setup(), other = await f.login();
  const response = await f.manage(session, '/auth/logout', {});
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.manage(session, '/v1/keys')).status, 401);
  assert.equal((await f.manage(other, '/v1/keys')).status, 200);
  f.advance(8 * 60 * 60 * 1000 + 1);
  assert.equal((await f.manage(other, '/v1/keys')).status, 401);
});

test('password changes require the current password, invalidate every admin session and keep client keys', async t => {
  const f = await fixture(t), session = await f.setup(), other = await f.login();
  const token = (await f.keys.create({ name: 'existing client' })).api_key;
  assert.equal((await f.manage(session, '/auth/password', { current_password: 'wrong', new_password: replacement })).status, 401);
  assert.equal((await f.manage(session, '/v1/keys')).status, 200);
  assert.equal((await f.manage(session, '/auth/password', { current_password: password, new_password: replacement })).status, 200);
  for (const s of [session, other]) assert.equal((await f.manage(s, '/v1/keys')).status, 401);
  assert.equal((await f.request('/auth/login', { body: { username: 'admin', password } })).status, 401);
  assert.equal((await f.manage(await f.login(replacement), '/v1/keys')).status, 200);
  assert.equal((await f.request('/v1/models', { token })).status, 200);
});

test('failed login throttling cannot be bypassed with a forged forwarded IP and clears after the window', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 5; i++) {
    const response = await f.request('/auth/login', { body: { username: i % 2 ? 'missing-user' : 'admin', password: 'bad' }, headers: { 'x-forwarded-for': '192.0.2.' + i } });
    assert.equal(response.status, 401); assert.equal((await response.json()).error.message, 'Username or password is incorrect.');
  }
  const blocked = await f.request('/auth/login', { body: { username: 'admin', password }, headers: { 'x-forwarded-for': '203.0.113.1' } });
  assert.equal(blocked.status, 429); assert(Number(blocked.headers.get('retry-after')) > 0);
  f.advance(15 * 60 * 1000 + 1);
  assert.equal((await f.manage(await f.login(), '/v1/keys')).status, 200);
});

test('administrator credentials and sessions survive restart, and corrupt or removed stores fail closed', async t => {
  const f = await fixture(t), session = await f.setup();
  const restarted = new AdminAuth(f.runtime, { bootstrapKey: bootstrap }); await restarted.initialize();
  const cookieReq = { headers: { cookie: session.cookie } };
  assert.equal((await restarted.session(cookieReq)).username, 'Admin');
  assert((await restarted.login({ username: 'admin', password }, 'fixture')).token);
  await fs.writeFile(f.auth.file, 'corrupt');
  assert.equal((await f.manage(session, '/v1/keys')).status, 503);
  await assert.rejects(new AdminAuth(f.runtime, { bootstrapKey: bootstrap }).initialize(), { code: 'admin_auth_unavailable' });
  assert.equal(await fs.readFile(f.auth.file, 'utf8'), 'corrupt');
  await fs.unlink(f.auth.file);
  assert.equal((await f.request('/auth/setup', { body: { bootstrap_key: bootstrap, username: 'admin', password } })).status, 503);
});

test('an explicit HTTPS public origin enables Secure cookies and pins accepted browser origins', async t => {
  const f = await fixture(t, { publicOrigin: 'https://gateway.example' });
  const response = await f.request('/auth/setup', { origin: 'https://gateway.example', body: { bootstrap_key: bootstrap, username: 'admin', password } });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal((await f.request('/auth/login', { origin: f.base, body: { username: 'admin', password } })).status, 403);
  assert.throws(() => new AdminAuth(f.runtime, { publicOrigin: 'https://gateway.example/path' }), /Invalid LINEAR_PUBLIC_URL/);
});

test('login, initialization and password forms contain syntactically valid scripts and no embedded credentials', () => {
  for (const page of [LOGIN_HTML, SETUP_HTML, SECURITY_HTML, ACCOUNTS_HTML, KEYS_HTML]) {
    assert.doesNotThrow(() => new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]));
    assert(!page.includes(bootstrap)); assert(!page.includes(password));
  }
});

test('CLI management logs in from a password file, uses CSRF and revokes its session on completion', async t => {
  const f = await fixture(t); await f.setup();
  const file = new URL('cli-password.txt', f.runtime);
  await fs.writeFile(file, password + '\r\n', { mode: 0o600 });
  const session = await openAdminSession(f.base, { username: 'admin', passwordFile: file });
  assert.equal((await session.request('/v1/keys', { name: 'CLI session' })).status, 201);
  await session.close();
  await assert.rejects(session.request('/v1/keys'), /session is closed/);
  await assert.rejects(openAdminSession(f.base, { username: '', passwordFile: file }), /LINEAR_ADMIN_USERNAME/);
});

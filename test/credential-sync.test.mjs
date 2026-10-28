import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import vm from 'node:vm';
import { AccountStore } from '../accounts.mjs';
import { AccountRouter } from '../routing.mjs';
import { AdminAuth } from '../admin-auth.mjs';
import { CredentialSync } from '../credential-sync.mjs';
import { ClientKeyStore } from '../client-keys.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT, GatewayError } from '../upstream.mjs';
import { modelEntries } from '../models.mjs';
import { BrowserSync, gatewayOrigin, gatewayPost, permissionOrigin, probeLinear } from '../browser-extension/sync.mjs';

const origin = 'chrome-extension://' + 'a'.repeat(32), otherOrigin = 'chrome-extension://' + 'b'.repeat(32);
const master = 'TEST_SYNC_BOOTSTRAP_' + 'x'.repeat(40);
const credential = (cookie = 'INITIAL_TEST_COOKIE', user = 'fixture-user', organization = 'fixture-org') => ({ endpoint: ENDPOINT, headers: { cookie, user, organization } });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-sync-test-')), runtime = pathToFileURL(directory + path.sep);
  let server, accounts, sync, clock = Date.now(), hold; const calls = [];
  t.after(async () => {
    await server?.shutdown(); await sync?.writer; await accounts?.writer;
    const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('linear-sync-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  accounts = new AccountStore(runtime, { fetchImpl: async (url, options) => {
    assert.equal(url, ENDPOINT); const body = JSON.parse(options.body); calls.push(body.query);
    assert(!body.query.includes('mutation')); assert(!body.query.includes('aiConversationSendMessage'));
    if (hold) await hold();
    if (options.headers.cookie === 'EXPIRED_TEST_COOKIE') return new Response(JSON.stringify({ errors: [{ message: 'MUST_NOT_LEAK', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), { status: 401 });
    const user = options.headers.cookie === 'MISMATCH_TEST_COOKIE' ? 'different-viewer' : options.headers.user;
    return new Response(JSON.stringify({ data: { viewer: { id: user, name: 'Fixture' }, organization: { id: options.headers.organization, name: 'Fixture workspace' } } }));
  } });
  await accounts.initialize(); const id = (await accounts.import(credential(), 'Primary account')).account.id;
  const second = (await accounts.import(credential('SECOND_TEST_COOKIE', 'other-user'), 'Second account')).account.id;
  sync = new CredentialSync(runtime, accounts, { now: () => clock }); await sync.initialize();
  const auth = new AdminAuth(runtime, { bootstrapKey: master }); await auth.initialize();
  const keys = new ClientKeyStore(runtime, { adminKey: master }); await keys.initialize();
  const router = new AccountRouter(accounts, { now: () => clock, modelsProvider: async () => modelEntries() }); await router.initialize();
  server = createGateway({ apiKey: master, accountStore: accounts, accountRouter: router, adminAuth: auth, clientKeys: keys, credentialSync: sync });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = 'http://127.0.0.1:' + server.address().port;
  const initialized = await fetch(base + '/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap_key: master, username: 'fixture-admin', password: 'Synthetic sync administrator passphrase!' }) });
  const cookie = initialized.headers.get('set-cookie').split(';')[0], csrf = (await initialized.json()).csrf_token;
  const request = (route, { body, token, extension = origin, browserOrigin = extension, admin = false, csrfToken = csrf, headers = {}, method } = {}) => fetch(base + route, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual', headers: { 'content-type': 'application/json', ...(extension ? { 'x-linear-sync-origin': extension } : {}), ...(browserOrigin ? { origin: browserOrigin } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(admin ? { cookie, 'x-csrf-token': csrfToken, origin: base } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const manage = (route, body, extra = {}) => request(route, { admin: true, body, ...extra });
  async function pair(accountId = id, extension = origin, user = 'fixture-user', organization = 'fixture-org') {
    const created = await manage('/v1/accounts/' + accountId + '/sync/pairing', {}); assert.equal(created.status, 201);
    const { pairing_code } = await created.json();
    const paired = await request('/sync/pair', { extension, body: { pairing_code, user_id: user, organization_id: organization } }); assert.equal(paired.status, 200);
    return { ...(await paired.json()), pairing_code };
  }
  return { runtime, sync, accounts, router, keys, request, manage, pair, id, second, base, calls, setHold: fn => { hold = fn; }, advance: ms => { clock += ms; }, now: () => clock };
}

test('pairing creation is administrator-only and retains CSRF protection', async t => {
  const f = await fixture(t), route = '/v1/accounts/' + f.id + '/sync/pairing';
  assert.equal((await f.request(route, { token: master, body: {} })).status, 401);
  const client = (await f.keys.create({ name: 'client' })).api_key;
  assert.equal((await f.request(route, { token: client, body: {} })).status, 403);
  assert.equal((await f.manage(route, {}, { csrfToken: 'forged' })).status, 403);
  assert.equal((await f.manage(route, {})).status, 201);
});

test('pairing codes are single-use, expire in ten minutes and persist only digests', async t => {
  const f = await fixture(t), pairing = await f.pair();
  const stored = await fs.readFile(f.sync.file, 'utf8');
  assert(!stored.includes(pairing.pairing_code)); assert(!stored.includes(pairing.sync_token));
  const listing = JSON.stringify(await f.sync.list(f.id)); assert(!listing.includes('digest')); assert(!listing.includes(pairing.sync_token));
  assert.equal((await f.request('/sync/pair', { body: { pairing_code: pairing.pairing_code, user_id: 'fixture-user', organization_id: 'fixture-org' } })).status, 401);
  const code = (await (await f.manage('/v1/accounts/' + f.id + '/sync/pairing', {})).json()).pairing_code;
  f.advance(600001);
  assert.equal((await f.request('/sync/pair', { body: { pairing_code: code, user_id: 'fixture-user', organization_id: 'fixture-org' } })).status, 401);
  const restarted = new CredentialSync(f.runtime, f.accounts, { now: f.now }); await restarted.initialize();
  assert.equal(restarted.grant(await restarted.read(), pairing.sync_token, origin).account_id, f.id);
});

test('sync validates identity before saving and restores the bound account without changing other account data', async t => {
  const f = await fixture(t), p = await f.pair();
  await f.router.recordFailure(await f.accounts.get(f.id), new GatewayError(503, 'linear_session_expired', 'Synthetic failure.'));
  assert.equal((await f.router.status()).accounts.find(a => a.id === f.id).status, 'needs_login');
  const updated = await f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('UPDATED_TEST_COOKIE') } }); assert.equal(updated.status, 200);
  assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'UPDATED_TEST_COOKIE');
  assert.equal((await f.accounts.get(f.id)).label, 'Primary account');
  assert.equal((await f.accounts.get(f.second)).session.headers.cookie, 'SECOND_TEST_COOKIE');
  assert.equal((await f.accounts.list()).data.length, 2);
  assert.equal((await f.router.status()).accounts.find(a => a.id === f.id).status, 'ready');
  assert((await f.sync.list(f.id)).data[0].last_synced_at);
  assert.equal(f.calls.length, 1);
});

test('sync tokens are pinned to an extension and account and cannot access chats or management', async t => {
  const f = await fixture(t), p = await f.pair();
  assert.equal((await f.request('/sync/credentials', { token: p.sync_token, extension: otherOrigin, body: { credential: credential('NEW_TEST_COOKIE') } })).status, 401);
  assert.equal((await f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('NEW_TEST_COOKIE', 'other-user') } })).status, 409);
  for (const route of ['/v1/models', '/v1/accounts', '/v1/keys']) assert.equal((await f.request(route, { token: p.sync_token })).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'INITIAL_TEST_COOKIE');
});

test('expired or mismatched browser sessions never replace a valid credential, and update requests are throttled', async t => {
  const f = await fixture(t), p = await f.pair();
  const failed = await f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('EXPIRED_TEST_COOKIE') } }); assert.equal(failed.status, 503); assert(!(await failed.text()).includes('MUST_NOT_LEAK'));
  assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'INITIAL_TEST_COOKIE');
  assert.equal((await f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('UPDATED_TEST_COOKIE') } })).status, 429);
  f.advance(30001);
  assert.equal((await f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('MISMATCH_TEST_COOKIE') } })).status, 409);
  assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'INITIAL_TEST_COOKIE');
});

test('ordinary websites cannot use sync CORS or password cookies and revocation invalidates the scoped token', async t => {
  const f = await fixture(t), p = await f.pair();
  assert.equal((await f.request('/sync/credentials', { method: 'OPTIONS', extension: null, browserOrigin: 'https://attacker.invalid' })).status, 403);
  const options = await f.request('/sync/credentials', { method: 'OPTIONS' }); assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), origin);
  assert.equal((await f.request('/sync/credentials', { browserOrigin: 'https://attacker.invalid', token: p.sync_token, body: { credential: credential() } })).status, 403);
  assert.equal((await f.request('/sync/credentials', { admin: true, extension: null, body: { credential: credential() } })).status, 403);
  assert.equal((await f.manage('/v1/accounts/' + f.id + '/sync/revoke', { sync_id: p.grant_id })).status, 200);
  assert.equal((await f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('UPDATED_TEST_COOKIE') } })).status, 401);
  const other = await f.pair(); assert.equal((await f.request('/sync/revoke', { token: other.sync_token, body: {} })).status, 200);
  assert.equal((await f.request('/sync/revoke', { token: other.sync_token, body: {} })).status, 401);
});

test('a newer manual credential import is not overwritten by an older in-flight browser check', async t => {
  const f = await fixture(t), p = await f.pair(); let ready, release;
  const started = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setHold(async () => { ready(); await gate; });
  const updating = f.request('/sync/credentials', { token: p.sync_token, body: { credential: credential('OLDER_TEST_COOKIE') } });
  await started; await f.accounts.import(credential('LATEST_MANUAL_TEST_COOKIE')); release();
  assert.equal((await updating).status, 409);
  assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'LATEST_MANUAL_TEST_COOKIE');
});

test('a corrupt sync store fails closed without resetting existing grants', async t => {
  const f = await fixture(t); await f.pair(); await fs.writeFile(f.sync.file, 'corrupt');
  await assert.rejects(new CredentialSync(f.runtime, f.accounts).initialize(), { code: 'sync_store_unavailable' });
  assert.equal(await fs.readFile(f.sync.file, 'utf8'), 'corrupt');
});

test('the extension pairs and automatically delivers updated browser credentials through the real local HTTP API', async t => {
  const f = await fixture(t), code = (await (await f.manage('/v1/accounts/' + f.id + '/sync/pairing', {})).json()).pairing_code;
  let bindings = [];
  const browser = new BrowserSync({ read: async () => structuredClone(bindings), save: async value => { bindings = structuredClone(value); }, post: (base, route, body, token) => gatewayPost(base, route, body, token, origin), probe: async () => ({ ok: true }), now: f.now });
  const bound = await browser.bind(f.base, code, credential('BROWSER_INITIAL_COOKIE'), { id: 7, url: 'https://linear.app/fixture/agent' });
  assert.equal(bound.synced, true); assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'BROWSER_INITIAL_COOKIE');
  assert(!JSON.stringify(bindings).includes('BROWSER_INITIAL_COOKIE'));
  assert(!JSON.stringify(await browser.publicBindings()).includes('lgs-'));
  f.advance(30001);
  await browser.observe({ tabId: 7, method: 'POST', url: ENDPOINT, initiator: 'https://linear.app', requestHeaders: Object.entries(credential('ROTATED_BROWSER_COOKIE').headers).map(([name, value]) => ({ name, value })) });
  assert.equal((await f.accounts.get(f.id)).session.headers.cookie, 'ROTATED_BROWSER_COOKIE');
  const count = f.calls.length;
  await browser.observe({ tabId: 7, method: 'POST', url: ENDPOINT, initiator: 'https://linear.app', requestHeaders: Object.entries(credential('ROTATED_BROWSER_COOKIE').headers).map(([name, value]) => ({ name, value })) });
  assert.equal(f.calls.length, count);
  await browser.remove(bindings[0].id); assert.deepEqual(bindings, []);
  assert.equal((await f.sync.list(f.id)).data[0].enabled, false);
});

test('extension failures back off and revoked grants disable future synchronization', async () => {
  let time = Date.now(), bindings = [], attempts = 0;
  const account = { id: 'acct-' + 'a'.repeat(20), label: 'Fixture', user_id: 'fixture-user', organization_id: 'fixture-org' };
  const browser = new BrowserSync({ read: async () => structuredClone(bindings), save: async value => { bindings = structuredClone(value); }, now: () => time, probe: async () => ({ ok: false, code: 'waiting_browser' }), post: async (_, route) => {
    if (route === '/sync/pair') return { account, grant_id: 'sync-' + 'b'.repeat(20), sync_token: 'lgs-' + 'c'.repeat(64) };
    attempts++; const error = new Error('Synthetic error.'); error.code = attempts === 1 ? 'sync_network_error' : 'invalid_sync_token'; throw error;
  } });
  await browser.bind('http://127.0.0.1:8089', 'lgp-' + 'd'.repeat(64), credential(), { id: 7, url: 'https://linear.app/fixture/agent' });
  assert.equal(attempts, 1); await browser.push(bindings[0].id, credential()); assert.equal(attempts, 1);
  time += 60001; await browser.push(bindings[0].id, credential()); assert.equal(attempts, 2);
  assert.equal(bindings[0].enabled, false); assert.equal(bindings[0].token, '');
  time += 999999; await browser.tick(); await browser.push(bindings[0].id, credential()); assert.equal(attempts, 2);
});

test('scheduled browser checks use readonly identity queries and report missing tabs instead of inventing credentials', async () => {
  const script = new vm.Script('(' + probeLinear.toString() + ')(identity)'); let body;
  const result = await script.runInNewContext({ identity: { user_id: 'fixture-user', organization_id: 'fixture-org' }, AbortSignal, fetch: async (url, options) => { assert.equal(url, ENDPOINT); assert.equal(options.credentials, 'include'); body = JSON.parse(options.body); return new Response(JSON.stringify({ data: { viewer: { id: 'fixture-user' }, organization: { id: 'fixture-org' } } })); } });
  assert.equal(result.ok, true); assert(body.query.startsWith('query ')); assert(!body.query.includes('mutation'));
  let bindings = [{ id: 'fixture', enabled: true }];
  const browser = new BrowserSync({ read: async () => structuredClone(bindings), save: async value => { bindings = value; }, post: async () => { throw new Error('Should not send credentials.'); }, probe: async () => ({ ok: false, code: 'waiting_browser' }) });
  await browser.tick(); assert.equal(bindings[0].last_probe_error, 'waiting_browser');
});

test('gateway targets require HTTPS or loopback and permission requests are limited to the chosen host', () => {
  assert.equal(gatewayOrigin('http://127.0.0.1:8089/'), 'http://127.0.0.1:8089');
  assert.equal(permissionOrigin('https://gateway.example:8443'), 'https://gateway.example/*');
  for (const value of ['http://remote.example', 'https://gateway.example/v1', 'https://user:secret@gateway.example', 'https://gateway.example?key=secret', 'file:///tmp/test']) assert.throws(() => gatewayOrigin(value));
});

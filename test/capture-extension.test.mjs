import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { CaptureController, capturedSession, ENDPOINT, isLinearPage } from '../browser-extension/capture.mjs';
import { sessionFromCredentials } from '../accounts.mjs';
import { captureExtensionArchive, crc32, EXTENSION_FILES } from '../capture-extension.mjs';

const request = (tabId = 7, extra = {}) => ({ tabId, method: 'POST', url: ENDPOINT, initiator: 'https://linear.app', requestHeaders: [
  { name: 'Cookie', value: 'linear=SYNTHETIC_CAPTURE_COOKIE' }, { name: 'User', value: 'fixture-user' }, { name: 'Organization', value: 'fixture-org' },
  { name: 'Authorization', value: 'DO_NOT_COPY' }, { name: 'X-Unrelated', value: 'DO_NOT_COPY' }
], ...extra });
const tab = id => ({ id, url: 'https://linear.app/fixture/agent' });
function fixture() {
  let state = null, time = 1000000;
  const reloads = [], alarms = [];
  const options = { read: async () => structuredClone(state), save: async value => { state = structuredClone(value); }, clear: async () => { state = null; }, expireAt: async when => { alarms.push(when); }, reload: async id => { reloads.push(id); }, now: () => time };
  return { controller: new CaptureController(options), restart: () => new CaptureController(options), reloads, alarms, advance: ms => { time += ms; }, state: () => state };
}

test('captured request exports an importable session and drops unrelated headers', () => {
  const value = capturedSession(request(), 7, 1000);
  assert.equal(value.capturedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(sessionFromCredentials(JSON.stringify(value)).headers.cookie, 'linear=SYNTHETIC_CAPTURE_COOKIE');
  assert(!JSON.stringify(value).includes('DO_NOT_COPY'));
  const split = request(); split.requestHeaders.push({ name: 'cookie', value: 'second=FIXTURE' });
  assert.equal(capturedSession(split, 7).headers.cookie, 'linear=SYNTHETIC_CAPTURE_COOKIE; second=FIXTURE');
});

test('capture rejects other tabs, endpoints, initiators, incomplete identities and ambiguous headers', () => {
  for (const extra of [{ tabId: 8 }, { method: 'GET' }, { url: ENDPOINT + '?other' }, { url: 'https://client-api.linear.app.evil.invalid/graphql' }, { initiator: 'https://linear.app.evil.invalid' }]) assert.equal(capturedSession(request(7, extra), 7), null);
  for (const required of ['Cookie', 'User', 'Organization']) assert.equal(capturedSession(request(7, { requestHeaders: request().requestHeaders.filter(h => h.name !== required) }), 7), null);
  const duplicate = request(); duplicate.requestHeaders.push({ name: 'user', value: 'another-user' });
  assert.equal(capturedSession(duplicate, 7), null);
  const malformed = request(); malformed.requestHeaders[0].value += '\r\nInjected: true';
  assert.equal(capturedSession(malformed, 7), null);
  assert.equal(isLinearPage('https://linear.app.evil.invalid/workspace'), false);
  assert.equal(isLinearPage('http://linear.app/workspace'), false);
});

test('capture starts only after a click, is bound to one tab and consumes the result once', async () => {
  const f = fixture(), c = f.controller;
  assert.equal(await c.capture(request()), false); assert.equal(f.state(), null);
  await assert.rejects(c.start({ id: 7, url: 'https://other.invalid' }));
  await assert.rejects(c.start({ ...tab(7), incognito: true }));
  await c.start(tab(7)); assert.deepEqual(f.reloads, [7]);
  assert.equal(await c.capture(request(7, { timeStamp: f.state().started_at - 1 })), false);
  assert.equal(await c.capture(request(8)), false);
  assert.equal(await c.capture(request()), true);
  const status = await c.status(7);
  assert.equal(status.phase, 'ready'); assert.equal(status.user, 'fixture-user');
  assert(!JSON.stringify(status).includes('COOKIE')); assert(!('credential' in status));
  assert.deepEqual(await c.status(8), { phase: 'idle' });
  await assert.rejects(c.take(8));
  assert.equal((await c.take(7)).headers.organization, 'fixture-org');
  assert.equal(f.state(), null); await assert.rejects(c.take(7));
});

test('worker suspension preserves the selected capture, while new captures never reuse another account', async () => {
  const f = fixture(); await f.controller.start(tab(7));
  const restarted = f.restart(); assert.equal((await restarted.status(7)).phase, 'waiting');
  await restarted.capture(request()); assert.equal((await f.restart().status(7)).phase, 'ready');
  await restarted.start(tab(8));
  assert.equal(await restarted.capture(request(7)), false);
  const incomplete = request(8, { requestHeaders: [{ name: 'User', value: 'other-user' }] });
  assert.equal(await restarted.capture(incomplete), false);
  assert.equal((await restarted.status(8)).phase, 'waiting');
  const second = request(8); second.requestHeaders[1].value = 'other-user';
  await restarted.capture(second); assert.equal((await restarted.take(8)).headers.user, 'other-user');
});

test('capture cancellation and expiry clear secrets and concurrent requests retain only the first complete identity', async () => {
  const f = fixture(), c = f.controller;
  await c.start(tab(7)); f.advance(90001); assert.equal(await c.capture(request()), false); assert.equal(f.state(), null);
  await c.start(tab(7));
  assert.deepEqual(await Promise.all([c.capture(request()), c.capture(request())]), [true, false]);
  assert.equal(f.alarms.at(-1) - f.alarms.at(-2), 210000);
  await c.cancel(8); assert.equal((await c.status(7)).phase, 'ready');
  f.advance(300001); await c.expire(); assert.equal(f.state(), null); await assert.rejects(c.take(7));
  await c.start(tab(7)); await c.capture(request()); await c.cancel(7); assert.equal(f.state(), null);
});

test('extension worker accepts only its own popup messages and registers an observational request listener', async () => {
  const f = fixture(), listeners = {};
  const event = name => ({ addListener: (...args) => { listeners[name] = args; } });
  const chrome = { runtime: { id: 'fixture-extension', getURL: name => 'chrome-extension://fixture-extension/' + name, onMessage: event('message') },
    storage: { session: { get: async () => ({ capture: f.state() }), set: async ({ capture }) => f.controller.save(capture), remove: () => f.controller.clear() } },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event('alarm') },
    tabs: { get: async id => tab(id), reload: async () => {}, onRemoved: event('removed') },
    webRequest: { onSendHeaders: event('request') } };
  const source = (await fs.readFile(new URL('../browser-extension/background.mjs', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  new vm.Script(source).runInNewContext({ chrome, CaptureController, ENDPOINT });
  assert.deepEqual(Array.from(listeners.request[1].urls), [ENDPOINT]);
  assert.deepEqual(Array.from(listeners.request[2]), ['requestHeaders', 'extraHeaders']);
  const handler = listeners.message[0], sender = { id: 'fixture-extension', url: chrome.runtime.getURL('popup.html') };
  assert.equal(handler({ type: 'start', tab_id: 7 }, { ...sender, url: 'https://linear.app' }, () => { throw new Error('Untrusted sender accepted.'); }), false);
  const result = await new Promise(resolve => { assert.equal(handler({ type: 'start', tab_id: 7 }, sender, resolve), true); });
  assert.equal(result.ok, true); assert.equal(result.data.phase, 'waiting');
});

test('downloaded ZIP contains exactly the reviewed extension sources and limited permissions', async () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = await captureExtensionArchive(), entries = new Map();
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50); assert.equal(zip.readUInt16LE(end + 10), EXTENSION_FILES.length);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < EXTENSION_FILES.length; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const length = zip.readUInt16LE(at + 28), name = zip.subarray(at + 46, at + 46 + length).toString();
    const offset = zip.readUInt32LE(at + 42), size = zip.readUInt32LE(at + 24);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const data = zip.subarray(offset + 30 + length, offset + 30 + length + size);
    assert.equal(crc32(data), zip.readUInt32LE(at + 16));
    entries.set(name, data); at += 46 + length;
  }
  assert.equal(at, end); assert.deepEqual([...entries.keys()], EXTENSION_FILES);
  const manifest = JSON.parse(entries.get('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://linear.app/*', 'https://client-api.linear.app/*']);
  assert.deepEqual(manifest.permissions, ['webRequest', 'storage', 'alarms']);
  assert.equal(manifest.incognito, 'not_allowed');
  assert(!manifest.content_scripts); assert(!manifest.externally_connectable);
  assert(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
  assert.doesNotThrow(() => new vm.Script(entries.get('popup.mjs').toString().replace(/^import[^\n]+\n/, '')));
});

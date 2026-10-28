import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { GatewayError, MODEL } from './upstream.mjs';
import { WELCOME_HTML } from './welcome.mjs';
import { ACCOUNTS_HTML } from './accounts-page.mjs';
import { Scheduler } from './scheduler.mjs';
import { ToolSessionStore } from './tool-sessions.mjs';
import { createChatCompletions } from './chat-completions.mjs';
import { KEYS_HTML } from './keys-page.mjs';
import { LOGIN_HTML, SETUP_HTML, SECURITY_HTML } from './admin-pages.mjs';
import { captureExtensionArchive } from './capture-extension.mjs';
import { isExtensionOrigin } from './credential-sync.mjs';

export async function ensureAccess(runtimeDir) {
  await fs.mkdir(runtimeDir, { recursive: true });
  const path = new URL('access.json', runtimeDir);
  try {
    const access = JSON.parse(await fs.readFile(path, 'utf8'));
    if (typeof access.api_key !== 'string' || access.api_key.length < 32) throw new Error('Invalid local API key');
    return access;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const access = { api_key: 'lg-' + randomBytes(32).toString('hex') };
    await fs.writeFile(path, JSON.stringify(access, null, 2), { flag: 'wx', mode: 0o600 });
    return access;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" });
  res.end(body);
}
function redirect(res, location) { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); }
function errorPayload(error) {
  return { error: { message: error.message, type: error.status < 500 ? 'invalid_request_error' : 'api_error', code: error.code }, ...(error.routing ? { routing: error.routing } : {}) };
}
async function readBody(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new GatewayError(413, 'request_too_large', 'Request body exceeds the endpoint size limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError(400, 'invalid_json', 'Request body is not valid JSON.'); }
}

export function createGateway({ apiKey, sessionFile, accountStore, accountRouter, clientKeys, adminAuth, credentialSync, pollMs = 1500, timeoutMs = 180000, maxQueue = 8, maxConcurrency = 4, accountConcurrency = 1, maxBodyBytes = 8 * 1024 * 1024, chat = {}, toolSessions = new ToolSessionStore(null), clientFactory, modelsProvider = async () => [{ id: MODEL, name: 'Linear 默认配置', object: 'model', created: 0, owned_by: 'linear', test_status: 'default', selection_verified: false }], onError = () => {} }) {
  let accepting = true;
  const controllers = new Set();
  const requests = new Set();
  const expectedKey = Buffer.from('Bearer ' + apiKey);
  const catalog = accountId => accountRouter ? accountRouter.models(accountId) : modelsProvider(accountId);
  const scheduler = new Scheduler({ maxConcurrency, accountConcurrency, maxQueue });
  const completions = createChatCompletions({ accountStore, accountRouter, clientKeys, sessionFile, modelsProvider, catalog, clientFactory, pollMs, timeoutMs, scheduler, toolSessions, settings: chat, onError, controllers });
  const server = http.createServer(async (req, res) => {
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    requests.add(completion);
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const path = requestUrl.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', service: 'linear-agent-gateway', model: MODEL });
      if (['/sync/pair', '/sync/credentials', '/sync/revoke'].includes(path)) {
        const origin = req.headers.origin, claimed = req.headers['x-linear-sync-origin'];
        if (req.method === 'OPTIONS') {
          if (!isExtensionOrigin(origin)) throw new GatewayError(403, 'invalid_sync_origin', 'Only a browser extension may request credential sync access.');
          res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, authorization, x-linear-sync-origin', 'access-control-max-age': '600', vary: 'Origin' }); return res.end();
        }
        if (!isExtensionOrigin(claimed) || (origin && origin !== claimed)) throw new GatewayError(403, 'invalid_sync_origin', 'The browser extension origin does not match.');
        if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); }
        if (req.method !== 'POST') throw new GatewayError(404, 'not_found', 'Sync endpoint not found.');
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new GatewayError(415, 'json_required', 'Credential sync requests must use JSON.');
        if (!credentialSync) throw new GatewayError(503, 'sync_unavailable', 'Credential sync is not configured.');
        const body = await readBody(req, path === '/sync/credentials' ? 256 * 1024 : 8192);
        if (path === '/sync/pair') return json(res, 200, await credentialSync.pair(body, claimed, req.socket.remoteAddress ?? 'unknown'));
        const authorization = req.headers.authorization ?? '', token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (path === '/sync/credentials') return json(res, 200, await credentialSync.receive(body, token, claimed));
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new GatewayError(400, 'invalid_sync_request', 'Expected an empty revoke request.');
        return json(res, 200, await credentialSync.revokeToken(token, claimed));
      }
      if (adminAuth && req.method === 'GET' && ['/login', '/setup', '/admin', '/admin/security', '/accounts', '/keys', '/admin/capture-extension.zip'].includes(path)) {
        const configured = await adminAuth.configured(), session = await adminAuth.session(req);
        if (!configured) return path === '/setup' ? html(res, SETUP_HTML) : redirect(res, '/setup');
        if (path === '/setup') return redirect(res, session ? '/keys' : '/login');
        if (path === '/login') {
          if (!session) return html(res, LOGIN_HTML);
          const next = requestUrl.searchParams.get('next');
          return redirect(res, ['/keys', '/accounts', '/admin/security'].includes(next) ? next : '/keys');
        }
        if (!session) return redirect(res, '/login?next=' + encodeURIComponent(path === '/admin' ? '/keys' : path));
        if (path === '/admin') return redirect(res, '/keys');
        if (path === '/admin/capture-extension.zip') {
          const archive = await captureExtensionArchive();
          res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="linear-credential-capture.zip"', 'content-length': archive.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
          return res.end(archive);
        }
        return html(res, path === '/keys' ? KEYS_HTML : path === '/accounts' ? ACCOUNTS_HTML : SECURITY_HTML);
      }
      if (adminAuth && path.startsWith('/auth/')) {
        const session = await adminAuth.session(req);
        if (req.method === 'GET' && path === '/auth/session') return json(res, 200, { configured: await adminAuth.configured(), authenticated: Boolean(session), ...(session ? { username: session.username, expires_at: session.expires_at, csrf_token: session.csrf_token } : {}) });
        if (req.method === 'POST' && ['/auth/setup', '/auth/login', '/auth/logout', '/auth/password'].includes(path)) {
          const needsSession = ['/auth/logout', '/auth/password'].includes(path);
          if (needsSession && !session) throw new GatewayError(401, 'admin_login_required', 'Sign in with an administrator username and password first.');
          adminAuth.assertMutation(req, needsSession ? session : null);
          const body = await readBody(req, 8192), ip = req.socket.remoteAddress ?? 'unknown';
          if (path === '/auth/setup' || path === '/auth/login') {
            const result = path === '/auth/setup' ? await adminAuth.setup(body, ip) : await adminAuth.login(body, ip);
            res.setHeader('set-cookie', adminAuth.cookie(result.token, req));
            return json(res, 200, { authenticated: true, username: result.username, expires_at: result.expires_at, csrf_token: result.csrf_token });
          }
          if (path === '/auth/password') await adminAuth.changePassword(session, body, ip);
          else await adminAuth.logout(session);
          res.setHeader('set-cookie', adminAuth.cookie('', req, true));
          return json(res, 200, { authenticated: false });
        }
        throw new GatewayError(404, 'not_found', 'Authentication endpoint not found.');
      }
      if (req.method === 'GET' && ['/', '/v1', '/v1/', '/index.html', '/accounts', '/keys'].includes(path)) {
        return html(res, path === '/accounts' ? ACCOUNTS_HTML : path === '/keys' ? KEYS_HTML : WELCOME_HTML);
      }
      if (req.method === 'GET' && path === '/ui/models') return json(res, 200, { object: 'list', data: await catalog() });
      const authorization = req.headers.authorization ?? '';
      const key = Buffer.from(authorization);
      const administrator = key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
      const management = path.startsWith('/v1/accounts') || path === '/v1/routing' || path.startsWith('/v1/keys');
      const session = adminAuth && management ? await adminAuth.session(req) : null;
      const clientKey = !administrator && !session && clientKeys && authorization.startsWith('Bearer ') ? await clientKeys.authenticate(authorization.slice(7)) : null;
      if (adminAuth && management) {
        if (!session) throw new GatewayError(clientKey ? 403 : 401, clientKey ? 'admin_key_required' : 'admin_login_required', 'Sign in with an administrator username and password to manage the gateway.');
        if (!['GET', 'HEAD'].includes(req.method)) adminAuth.assertMutation(req, session);
      } else {
        if (!administrator && !clientKey) throw new GatewayError(401, 'invalid_api_key', 'A valid gateway Bearer API key is required.');
        if (!administrator && management) throw new GatewayError(403, 'admin_key_required', 'Sign in with an administrator username and password to manage the gateway.');
      }
      if (path.startsWith('/v1/keys')) {
        if (!clientKeys) throw new GatewayError(503, 'keys_unavailable', 'Client key management is not configured.');
        if (req.method === 'GET' && path === '/v1/keys') return json(res, 200, await clientKeys.list());
        if (req.method === 'POST' && path === '/v1/keys') return json(res, 201, await clientKeys.create(await readBody(req, 4096)));
        const match = path.match(/^\/v1\/keys\/(key-[a-f0-9]{20})\/status$/);
        if (req.method === 'POST' && match) {
          const body = await readBody(req, 4096);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'enabled')) throw new GatewayError(400, 'invalid_client_key', 'Only enabled can be updated.');
          return json(res, 200, await clientKeys.setEnabled(match[1], body.enabled));
        }
        throw new GatewayError(404, 'not_found', 'Client key endpoint not found.');
      }
      if (path === '/v1/routing') {
        if (!accountRouter) throw new GatewayError(503, 'routing_unavailable', 'Account routing is not configured.');
        if (req.method === 'GET') return json(res, 200, await accountRouter.status());
        if (req.method === 'POST') return json(res, 200, await accountRouter.setPolicy(await readBody(req)));
        throw new GatewayError(404, 'not_found', 'Routing endpoint not found.');
      }
      if (path.startsWith('/v1/accounts')) {
        if (!accountStore) throw new GatewayError(503, 'accounts_unavailable', 'Account management is not configured.');
        if (req.method === 'GET' && path === '/v1/accounts') {
          const list = await accountStore.list();
          if (accountRouter) {
            const routing = await accountRouter.status();
            list.routing_policy = routing.policy;
            list.data = list.data.map(a => ({ ...a, routing: routing.accounts.find(v => v.id === a.id) }));
          }
          if (credentialSync) {
            const sync = await credentialSync.list();
            list.data = list.data.map(a => ({ ...a, credential_sync: sync.data.filter(g => g.account_id === a.id) }));
          }
          return json(res, 200, list);
        }
        if (req.method === 'POST' && path === '/v1/accounts/import') {
          const body = await readBody(req, 20 * 1024 * 1024);
          const imported = await accountStore.import(body?.credential, body?.label ?? '');
          const account = await accountStore.check(imported.account.id);
          return json(res, 200, { ...imported, account });
        }
        const syncMatch = path.match(/^\/v1\/accounts\/(acct-[a-f0-9]{20})\/sync(?:\/(pairing|revoke))?$/);
        if (syncMatch) {
          if (!credentialSync) throw new GatewayError(503, 'sync_unavailable', 'Credential sync is not configured.');
          await accountStore.get(syncMatch[1]);
          if (req.method === 'GET' && !syncMatch[2]) return json(res, 200, await credentialSync.list(syncMatch[1]));
          if (req.method === 'POST' && syncMatch[2] === 'pairing') return json(res, 201, await credentialSync.createPairing(syncMatch[1], await readBody(req, 4096)));
          if (req.method === 'POST' && syncMatch[2] === 'revoke') return json(res, 200, await credentialSync.revoke(syncMatch[1], await readBody(req, 4096)));
          throw new GatewayError(404, 'not_found', 'Credential sync management endpoint not found.');
        }
        const match = path.match(/^\/v1\/accounts\/(acct-[a-f0-9]{20})\/(check|default|routing|reset-cooldown)$/);
        if (req.method === 'POST' && match) {
          if (match[2] === 'check') return json(res, 200, { account: await accountStore.check(match[1]) });
          if (match[2] === 'default') return json(res, 200, await accountStore.setDefault(match[1]));
          if (!accountRouter) throw new GatewayError(503, 'routing_unavailable', 'Account routing is not configured.');
          if (match[2] === 'reset-cooldown') return json(res, 200, await accountRouter.clearCooldown(match[1]));
          const body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'enabled')) throw new GatewayError(400, 'invalid_routing_policy', 'Only enabled can be set for an account.');
          return json(res, 200, await accountRouter.setEnabled(match[1], body.enabled));
        }
        throw new GatewayError(404, 'not_found', 'Account endpoint not found.');
      }
      if (req.method === 'GET' && path === '/v1/models') return json(res, 200, { object: 'list', data: await catalog(requestUrl.searchParams.get('account_id') ?? undefined) });
      if (req.method !== 'POST' || path !== '/v1/chat/completions') throw new GatewayError(404, 'not_found', 'Endpoint not found.');
      if (!accepting) throw new GatewayError(503, 'shutting_down', 'Gateway is shutting down.');
      const body = await readBody(req, maxBodyBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError(400, 'invalid_request', 'Expected a JSON object.');
      await completions(req, res, { body, clientKey });
    } catch (cause) {
      const error = cause instanceof GatewayError ? cause : new GatewayError(500, 'internal_error', 'The local gateway could not complete the request.');
      onError({ code: error.code ?? 'internal_error', status: error.status ?? 500 });
      if (!res.destroyed) {
        if (res.headersSent) res.end('data: ' + JSON.stringify(errorPayload(error)) + '\n\ndata: [DONE]\n\n');
        else { if (error.retryAfter) res.setHeader('retry-after', String(error.retryAfter)); json(res, error.status ?? 500, errorPayload(error)); }
      }
    }
    finally { requests.delete(completion); finish(); }
  });
  server.scheduler = scheduler;
  server.toolSessions = toolSessions;
  server.shutdown = async () => {
    accepting = false;
    for (const controller of controllers) controller.abort(new GatewayError(503, 'shutting_down', 'Gateway is shutting down.'));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...requests]);
    await toolSessions?.flush?.();
  };
  return server;
}

import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ENDPOINT, GatewayError, LinearClient, loadSession, normalizeSession } from './upstream.mjs';

const ACCOUNT_ID = /^acct-[a-f0-9]{20}$/;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECK_QUERY = 'query LinearAccountCheck { viewer { id name } organization { id name } }';
const now = () => new Date().toISOString();

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new GatewayError(503, 'account_store_unavailable', 'Cannot read the local account store.');
  }
}
async function writeJson(file, value) {
  await fs.mkdir(new URL('./', file), { recursive: true });
  const temporary = new URL(file.href + '.tmp-' + randomUUID());
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
export function accountIdFor(session) {
  const { headers } = normalizeSession(session);
  return 'acct-' + createHash('sha256').update(JSON.stringify([headers.user, headers.organization])).digest('hex').slice(0, 20);
}
export function sessionFromCredentials(source) {
  let parsed = source;
  if (typeof source === 'string') {
    try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')); }
    catch { throw new GatewayError(400, 'invalid_credentials', 'The credential file is not valid JSON.'); }
  }
  if (parsed?.log) {
    if (!Array.isArray(parsed.log.entries)) throw new GatewayError(400, 'invalid_credentials', 'The HAR must contain a request entries array.');
    const entry = parsed.log.entries.findLast(e => e?.request?.url === ENDPOINT && typeof e.request?.postData?.text === 'string' && e.request.postData.text.includes('aiConversationSendMessage'));
    if (!entry) throw new GatewayError(400, 'invalid_credentials', 'No Linear Agent send-message request was found in this HAR.');
    if (entry.request.headers !== undefined && !Array.isArray(entry.request.headers)) throw new GatewayError(400, 'invalid_credentials', 'Invalid HAR request headers.');
    const headers = Object.fromEntries((entry.request.headers ?? []).filter(h => typeof h?.name === 'string').map(h => [h.name.toLowerCase(), h.value]));
    if (!headers.cookie && Array.isArray(entry.request.cookies)) headers.cookie = entry.request.cookies.filter(c => typeof c?.name === 'string' && typeof c?.value === 'string').map(c => `${c.name}=${c.value}`).join('; ');
    parsed = { endpoint: ENDPOINT, headers };
  }
  try {
    const session = normalizeSession(parsed);
    return { endpoint: ENDPOINT, headers: session.headers, capturedAt: now() };
  } catch {
    throw new GatewayError(400, 'invalid_credentials', 'A Linear session needs Cookie, user and organization headers for the exact Linear client API. A sanitized HAR without cookies cannot be imported.');
  }
}

export class AccountStore {
  constructor(runtimeDir, { fetchImpl = fetch } = {}) {
    this.runtimeDir = runtimeDir;
    this.accountsFile = new URL('accounts.json', runtimeDir);
    this.bindingsFile = new URL('conversation-accounts.json', runtimeDir);
    this.fetchImpl = fetchImpl;
    this.writer = Promise.resolve();
  }
  write(work) {
    const task = this.writer.then(work, work);
    this.writer = task.catch(() => {});
    return task;
  }
  async initialize(legacySessionFile) {
    const existing = await readJson(this.accountsFile, null);
    if (existing) { this.assertState(existing); return; }
    const state = { version: 1, defaultAccountId: null, legacyAccountId: null, accounts: [] };
    let legacy;
    if (legacySessionFile) {
      try { await fs.access(legacySessionFile); legacy = await loadSession(legacySessionFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (legacy) {
      const session = { endpoint: ENDPOINT, headers: legacy.headers };
      const id = accountIdFor(session);
      state.accounts.push({ id, label: '已登录账户', session, importedAt: now(), updatedAt: now(), lastCheck: null });
      state.defaultAccountId = id;
      state.legacyAccountId = id;
    }
    await writeJson(this.accountsFile, state);
    if (legacy) {
      const report = await readJson(new URL('model-validation.json', this.runtimeDir), null);
      if (report && (!report.account_id || report.account_id === state.legacyAccountId)) {
        await writeJson(this.modelReportPath(state.legacyAccountId), { ...report, account_id: state.legacyAccountId });
      }
      const bindings = await readJson(this.bindingsFile, {});
      const live = await readJson(new URL('live-validation.json', this.runtimeDir), null);
      for (const result of [...(report?.tests ?? []), ...(live?.tests ?? [])]) {
        if (CONVERSATION_ID.test(result.conversation_id ?? '')) bindings[result.conversation_id] ??= state.legacyAccountId;
      }
      await writeJson(this.bindingsFile, bindings);
    }
  }
  assertState(state) {
    if (state?.version !== 1 || !Array.isArray(state.accounts)) throw new GatewayError(503, 'account_store_unavailable', 'Unsupported local account store format.');
  }
  async state() {
    const state = await readJson(this.accountsFile, null);
    this.assertState(state);
    return state;
  }
  publicAccount(account, defaultId) {
    return { id: account.id, label: account.label, is_default: account.id === defaultId, user_id: account.session.headers.user, organization_id: account.session.headers.organization, imported_at: account.importedAt, updated_at: account.updatedAt, status: account.lastCheck?.status ?? 'unchecked', checked_at: account.lastCheck?.checkedAt ?? null, user_name: account.lastCheck?.userName ?? null, workspace_name: account.lastCheck?.workspaceName ?? null };
  }
  async list() {
    const state = await this.state();
    return { default_account_id: state.defaultAccountId, data: state.accounts.map(a => this.publicAccount(a, state.defaultAccountId)) };
  }
  async get(id) {
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new GatewayError(400, 'invalid_account', 'Invalid account ID.');
    const state = await this.state();
    const account = state.accounts.find(a => a.id === id);
    if (!account) throw new GatewayError(404, 'account_not_found', 'The selected Linear account does not exist.');
    return account;
  }
  async import(source, label = '') {
    if (typeof label !== 'string' || label.length > 80) throw new GatewayError(400, 'invalid_account_label', 'Account label must be at most 80 characters.');
    const session = sessionFromCredentials(source);
    const id = accountIdFor(session);
    return this.write(async () => {
      const state = await this.state();
      const index = state.accounts.findIndex(a => a.id === id);
      const previous = state.accounts[index];
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt) || 0) + 1)).toISOString();
      const account = { id, label: label.trim() || previous?.label || `账户 ${state.accounts.length + 1}`, session, importedAt: previous?.importedAt ?? now(), updatedAt, lastCheck: null };
      if (index < 0) state.accounts.push(account); else state.accounts[index] = account;
      state.defaultAccountId ??= id;
      await writeJson(this.accountsFile, state);
      return { account: this.publicAccount(account, state.defaultAccountId), updated: index >= 0 };
    });
  }
  async setDefault(id) {
    await this.get(id);
    return this.write(async () => {
      const state = await this.state();
      state.defaultAccountId = id;
      await writeJson(this.accountsFile, state);
      return this.list();
    });
  }
  async check(id) {
    const account = await this.get(id);
    let lastCheck;
    try {
      const client = new LinearClient(normalizeSession(account.session), { fetchImpl: this.fetchImpl });
      const data = await client.call(CHECK_QUERY, {}, AbortSignal.timeout(20000));
      const matches = data.viewer?.id === account.session.headers.user && data.organization?.id === account.session.headers.organization;
      lastCheck = { status: matches ? 'valid' : 'invalid', checkedAt: now(), code: matches ? null : 'account_identity_mismatch', ...(matches ? { userName: data.viewer.name, workspaceName: data.organization.name } : {}) };
    } catch (error) {
      lastCheck = { status: error.code === 'linear_session_expired' ? 'invalid' : 'unavailable', checkedAt: now(), code: error.code ?? 'account_check_failed' };
    }
    return this.write(async () => {
      const state = await this.state();
      const current = state.accounts.find(a => a.id === id);
      // An import while this read-only check was running must not inherit an old check result.
      if (current.updatedAt === account.updatedAt && current.session.headers.cookie === account.session.headers.cookie) current.lastCheck = lastCheck;
      await writeJson(this.accountsFile, state);
      return this.publicAccount(current, state.defaultAccountId);
    });
  }
  async resolve({ accountId, conversationId } = {}) {
    if (accountId !== undefined && (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId))) throw new GatewayError(400, 'invalid_account', 'Invalid account ID.');
    const state = await this.state();
    let bound;
    if (conversationId !== undefined) {
      if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) throw new GatewayError(400, 'invalid_conversation', 'conversation_id must be a UUID.');
      bound = (await readJson(this.bindingsFile, {}))[conversationId];
    }
    if (bound && accountId !== undefined && bound !== accountId) throw new GatewayError(409, 'conversation_account_mismatch', 'This conversation belongs to another Linear account. Start a new conversation when switching accounts.');
    const id = bound ?? accountId ?? (conversationId ? state.legacyAccountId : null) ?? state.defaultAccountId;
    if (!id) throw new GatewayError(503, 'no_linear_accounts', 'Add a Linear account at /accounts first.');
    const account = await this.get(id);
    return { ...account, needsConversationCheck: Boolean(conversationId && !bound) };
  }
  async pin(conversationId, accountId) {
    if (!CONVERSATION_ID.test(conversationId ?? '')) throw new GatewayError(502, 'invalid_upstream_conversation', 'Linear returned an invalid conversation ID.');
    await this.get(accountId);
    return this.write(async () => {
      const bindings = await readJson(this.bindingsFile, {});
      if (bindings[conversationId] && bindings[conversationId] !== accountId) throw new GatewayError(409, 'conversation_account_mismatch', 'This conversation is already bound to another Linear account.');
      if (!bindings[conversationId]) { bindings[conversationId] = accountId; await writeJson(this.bindingsFile, bindings); }
    });
  }
  modelReportPath(id) {
    if (!ACCOUNT_ID.test(id ?? '')) throw new GatewayError(400, 'invalid_account', 'Invalid account ID.');
    return new URL(`model-validations/${id}.json`, this.runtimeDir);
  }
}

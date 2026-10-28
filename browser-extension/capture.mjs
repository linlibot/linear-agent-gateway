export const ENDPOINT = 'https://client-api.linear.app/graphql';
const WAIT_MS = 90000, RESULT_MS = 300000;
const HEADERS = new Set(['cookie', 'user', 'organization', 'useraccount', 'linear-client-id', 'linear-client-version', 'linear-client-database-id', 'user-agent']);
export function isLinearPage(value) {
  try { const url = new URL(value); return url.origin === 'https://linear.app' && !url.username && !url.password; }
  catch { return false; }
}

export function capturedSession(details, tabId, now = Date.now()) {
  if (details?.tabId !== tabId || details.method !== 'POST' || details.url !== ENDPOINT || details.initiator !== 'https://linear.app' || !Array.isArray(details.requestHeaders)) return null;
  const headers = {};
  let bytes = 0;
  for (const header of details.requestHeaders) {
    if (typeof header?.name !== 'string') continue;
    const name = header.name.toLowerCase();
    if (!HEADERS.has(name)) continue;
    if (typeof header.value !== 'string' || /[\r\n\0]/.test(header.value)) return null;
    bytes += header.value.length;
    if (bytes > 128 * 1024) return null;
    if (headers[name] !== undefined) {
      if (name === 'cookie') headers.cookie += '; ' + header.value;
      else if (headers[name] !== header.value) return null;
    } else headers[name] = header.value;
  }
  if (!['cookie', 'user', 'organization'].every(name => headers[name]?.trim())) return null;
  return { endpoint: ENDPOINT, headers, capturedAt: new Date(now).toISOString() };
}

// One explicitly armed tab, one complete request. Never combine accounts or
// collect before a click. Session storage survives MV3 worker suspension.
export class CaptureController {
  constructor({ read, save, clear, expireAt, reload, now = Date.now }) {
    Object.assign(this, { read, save, clear, expireAt, reload, now });
    this.writer = Promise.resolve();
  }
  write(work) {
    const result = this.writer.then(work, work);
    this.writer = result.catch(() => {});
    return result;
  }
  async current() {
    const state = await this.read();
    if (state && state.expires_at <= this.now()) { await this.clear(); return null; }
    return state;
  }
  start(tab) {
    return this.write(async () => {
      if (!Number.isInteger(tab?.id) || tab.id < 0 || tab.incognito || !isLinearPage(tab.url)) throw new Error('请在当前标签页打开并登录 Linear，进入要导入的工作区。');
      const state = { phase: 'waiting', tab_id: tab.id, started_at: this.now(), expires_at: this.now() + WAIT_MS };
      await this.save(state);
      await this.expireAt(state.expires_at);
      try { await this.reload(tab.id); }
      catch { await this.clear(); throw new Error('无法刷新当前 Linear 标签页，请重新打开扩展后重试。'); }
      return { phase: 'waiting', expires_at: state.expires_at };
    });
  }
  capture(details) {
    return this.write(async () => {
      const state = await this.current();
      if (state?.phase !== 'waiting') return false;
      if (Number.isFinite(details?.timeStamp) && details.timeStamp < state.started_at) return false;
      const credential = capturedSession(details, state.tab_id, this.now());
      if (!credential) return false;
      const result = { phase: 'ready', tab_id: state.tab_id, credential, expires_at: this.now() + RESULT_MS };
      await this.save(result);
      await this.expireAt(result.expires_at);
      return true;
    });
  }
  status(tabId) {
    return this.write(async () => {
      const state = await this.current();
      if (!state || state.tab_id !== tabId) return { phase: 'idle' };
      return { phase: state.phase, expires_at: state.expires_at, ...(state.phase === 'ready' ? { user: state.credential.headers.user, organization: state.credential.headers.organization } : {}) };
    });
  }
  take(tabId) {
    return this.write(async () => {
      const state = await this.current();
      if (state?.phase !== 'ready' || state.tab_id !== tabId) throw new Error('凭证已过期或不属于当前标签页，请重新提取。');
      await this.clear();
      return state.credential;
    });
  }
  cancel(tabId) {
    return this.write(async () => {
      const state = await this.read();
      if (tabId === undefined || state?.tab_id === tabId) await this.clear();
    });
  }
  expire() { return this.write(() => this.current()); }
}

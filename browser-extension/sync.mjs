import { capturedSession, isLinearPage } from './capture.mjs';

export function gatewayOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的网关地址，例如 http://127.0.0.1:8089。'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('网关地址需为 HTTPS，或本机 localhost / 127.0.0.1 地址，且不含路径和密钥。');
  return url.origin;
}
export const permissionOrigin = value => { const url = new URL(gatewayOrigin(value)); return url.protocol + '//' + url.hostname + '/*'; };
export const fingerprint = async credential => {
  const data = new TextEncoder().encode(JSON.stringify([credential.headers.user, credential.headers.organization, credential.headers.cookie]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
};
export function syncMessage(code) {
  return ({ invalid_sync_token: '配对已失效或被撤销，请重新配对。', sync_identity_mismatch: '当前浏览器账号或工作区与配对目标不一致。', linear_session_expired: 'Linear 登录已失效，请在浏览器重新登录。', waiting_browser: '等待打开已登录的 Linear 工作区标签页。', sync_rate_limited: '同步间隔过短，将自动稍后重试。', sync_network_error: '暂时无法连接网关，将自动重试。', probe_failed: '只读登录检查未成功，请检查 Linear 页面。' })[code] ?? '同步暂未成功，请检查网关连接及 Linear 登录状态。';
}
export async function gatewayPost(origin, route, body, token, extensionOrigin) {
  if (!['/sync/pair', '/sync/credentials', '/sync/revoke'].includes(route)) throw new Error('Unsupported sync route.');
  let response;
  try {
    response = await fetch(gatewayOrigin(origin) + route, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json', 'x-linear-sync-origin': extensionOrigin, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const data = await response.json();
    if (response.ok) return data;
    const error = new Error('网关未接受同步请求。');
    error.code = /^[a-z_]{1,80}$/.test(data?.error?.code ?? '') ? data.error.code : 'sync_network_error'; error.status = response.status;
    throw error;
  } catch (error) {
    if (error.code) throw error;
    const failure = new Error('无法连接网关。'); failure.code = 'sync_network_error'; throw failure;
  }
}

// This function executes in the Linear tab. It reads identity only and neither
// touches the DOM nor sends Agent messages. The browser manages its own cookies.
export async function probeLinear(identity) {
  try {
    const response = await fetch('https://client-api.linear.app/graphql', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', user: identity.user_id, organization: identity.organization_id }, body: JSON.stringify({ query: 'query GatewayBrowserKeepAlive { viewer { id } organization { id } }' }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if ([401, 403].includes(response.status) || data.errors?.some(e => /AUTHENTICATION|UNAUTHENTICATED/.test(e.extensions?.code ?? ''))) return { ok: false, code: 'linear_session_expired' };
    if (!response.ok || data.errors?.length) return { ok: false, code: 'probe_failed' };
    return data.data?.viewer?.id === identity.user_id && data.data?.organization?.id === identity.organization_id ? { ok: true } : { ok: false, code: 'sync_identity_mismatch' };
  } catch { return { ok: false, code: 'probe_failed' }; }
}

export class BrowserSync {
  constructor({ read, save, post, probe, now = Date.now, digest = fingerprint }) {
    Object.assign(this, { read, save, post, probe, now, digest }); this.writer = Promise.resolve(); this.ticking = false;
  }
  write(work) { const result = this.writer.then(work, work); this.writer = result.catch(() => {}); return result; }
  async publicBindings() {
    await this.writer;
    return (await this.read()).map(({ token, last_fingerprint, ...binding }) => binding);
  }
  async bind(origin, code, credential, tab) {
    origin = gatewayOrigin(origin);
    if (!/^lgp-[a-f0-9]{64}$/.test(code)) throw new Error('请粘贴后台为该账号生成的完整配对码。');
    if (!isLinearPage(tab.url) || tab.incognito) throw new Error('请在已登录的 Linear 标签页中配对。');
    const result = await this.post(origin, '/sync/pair', { pairing_code: code, user_id: credential.headers.user, organization_id: credential.headers.organization });
    if (!/^lgs-[a-f0-9]{64}$/.test(result.sync_token ?? '') || result.account?.user_id !== credential.headers.user || result.account?.organization_id !== credential.headers.organization || !/^acct-[a-f0-9]{20}$/.test(result.account.id) || !/^sync-[a-f0-9]{20}$/.test(result.grant_id ?? '')) throw new Error('网关返回了不匹配的配对信息。');
    const binding = { id: result.grant_id, gateway_origin: origin, account_id: result.account.id, label: result.account.label, user_id: result.account.user_id, organization_id: result.account.organization_id, token: result.sync_token, enabled: true, tab_id: tab.id, workspace_path: '/' + new URL(tab.url).pathname.split('/').filter(Boolean)[0], created_at: new Date(this.now()).toISOString() };
    await this.write(async () => {
      const bindings = (await this.read()).filter(b => b.gateway_origin !== origin || b.account_id !== binding.account_id);
      if (bindings.length >= 20) throw new Error('每个浏览器最多绑定 20 个账号。');
      bindings.push(binding); await this.save(bindings);
    });
    const synced = await this.push(binding.id, credential);
    return { account_id: binding.account_id, synced, message: synced ? '已配对并同步，之后每 15 分钟自动检查。' : '已配对，首次同步未成功，请查看同步状态。' };
  }
  push(id, credential) {
    return this.write(async () => {
      const bindings = await this.read(), binding = bindings.find(b => b.id === id && b.enabled);
      if (!binding || binding.user_id !== credential.headers.user || binding.organization_id !== credential.headers.organization) return false;
      const time = this.now(), digest = await this.digest(credential);
      if (time < (binding.next_retry_at ?? 0) || (binding.last_attempt_at && time - Date.parse(binding.last_attempt_at) < 30000) || (digest === binding.last_fingerprint && binding.last_synced_at && time - Date.parse(binding.last_synced_at) < 15 * 60 * 1000)) return false;
      binding.last_attempt_at = new Date(time).toISOString(); await this.save(bindings);
      try {
        const result = await this.post(binding.gateway_origin, '/sync/credentials', { credential }, binding.token);
        if (result.account_id !== binding.account_id || result.status !== 'valid') throw new Error('Unexpected sync response.');
        binding.last_synced_at = new Date(this.now()).toISOString(); binding.last_fingerprint = digest; binding.last_error_code = null; binding.last_probe_error = null; binding.failures = 0; binding.next_retry_at = 0;
        await this.save(bindings); return true;
      } catch (error) {
        binding.last_error_code = /^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'sync_network_error';
        binding.failures = Math.min(10, (binding.failures ?? 0) + 1); binding.next_retry_at = this.now() + Math.min(900000, 60000 * 2 ** (binding.failures - 1));
        if (error.code === 'invalid_sync_token' || error.code === 'invalid_sync_origin') { binding.enabled = false; binding.token = ''; }
        await this.save(bindings); return false;
      }
    });
  }
  async observe(details) {
    const credential = capturedSession(details, details.tabId, this.now());
    if (!credential) return;
    const ids = (await this.read()).filter(b => b.enabled && b.user_id === credential.headers.user && b.organization_id === credential.headers.organization).map(b => b.id);
    for (const id of ids) await this.push(id, credential);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const binding of (await this.read()).filter(b => b.enabled)) {
        if (this.now() < (binding.next_retry_at ?? 0)) continue;
        let result;
        try { result = await this.probe(binding); } catch { result = { ok: false, code: 'probe_failed' }; }
        await this.write(async () => { const bindings = await this.read(), current = bindings.find(b => b.id === binding.id); if (current) { current.last_probe_at = new Date(this.now()).toISOString(); current.last_probe_error = result.ok ? null : result.code; await this.save(bindings); } });
      }
    } finally { this.ticking = false; }
  }
  async remove(id) {
    return this.write(async () => {
      const bindings = await this.read(), binding = bindings.find(b => b.id === id);
      if (!binding) return;
      if (binding.token) await this.post(binding.gateway_origin, '/sync/revoke', {}, binding.token).catch(() => {});
      await this.save(bindings.filter(b => b.id !== id));
    });
  }
}

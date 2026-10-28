import { isLinearPage } from './capture.mjs';
import { gatewayOrigin, permissionOrigin, syncMessage } from './sync.mjs';
const $ = id => document.getElementById(id);
let tabId, timer, polling = false, pairing = false, pendingAction = '', pendingOrigin = '';
function notice(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, tab_id: tabId, ...extra });
  if (!result?.ok) throw new Error(result?.message ?? '提取工具未响应，请重新打开扩展。');
  return result.data;
}
function stopPolling() { clearInterval(timer); timer = undefined; }
function done() { pairing = false; pendingAction = ''; $('capture').disabled = !Number.isInteger(tabId); $('pair').disabled = !Number.isInteger(tabId); $('download').hidden = true; $('cancel').hidden = true; }
async function download() {
  pendingAction = ''; stopPolling();
  const credential = await send('export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(credential, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'linear-session-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  done(); notice('JSON 已生成，临时凭证已清除。\n请在网关后台导入文件；启用自动刷新后不需要反复下载。');
}
async function loadBindings() {
  const bindings = await send('bindings'); $('bindings').replaceChildren();
  if (!bindings.length) { $('bindings').textContent = '尚未配对账号'; return; }
  for (const binding of bindings) {
    const item = document.createElement('div'); item.className = 'binding';
    const title = document.createElement('strong'); title.textContent = binding.label;
    const detail = document.createElement('div'); detail.textContent = binding.gateway_origin + '\n最近同步：' + (binding.last_synced_at ? new Date(binding.last_synced_at).toLocaleString() : '尚未同步') + '\n' + (!binding.enabled ? '已停用，需重新配对' : binding.last_error_code || binding.last_probe_error ? syncMessage(binding.last_error_code || binding.last_probe_error) : '已启用 · 每 15 分钟检查'); detail.style.whiteSpace = 'pre-line';
    const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = '停止并移除此配对';
    remove.onclick = async () => { remove.disabled = true; try { await send('unbind', { id: binding.id }); await loadBindings(); notice('已停止本浏览器的同步。网关离线时，可在后台另行撤销授权。'); } catch (error) { fail(error); } };
    item.append(title, detail, remove); $('bindings').append(item);
  }
}
async function pair() {
  stopPolling(); notice('正在配对并校验 Linear 凭证…');
  const result = await send('pair', { gateway_origin: pendingOrigin, pairing_code: $('pair-code').value.trim() });
  $('pair-code').value = ''; done(); await loadBindings(); notice(result.message, !result.synced);
}
async function refresh() {
  if (polling) return; polling = true;
  try {
    const state = await send('status'), waiting = state.phase === 'waiting', ready = state.phase === 'ready';
    $('capture').disabled = waiting || pairing; $('pair').disabled = waiting || pairing; $('download').hidden = !ready || pairing; $('cancel').hidden = !waiting && !ready; $('identity').hidden = !ready;
    if (ready) {
      stopPolling(); $('user').textContent = state.user; $('organization').textContent = state.organization;
      notice('凭证已提取，可下载 JSON 或配对自动刷新。');
      if (pendingAction === 'download') await download(); else if (pendingAction === 'pair') await pair();
    } else if (waiting) {
      notice('正在等待当前标签页的登录请求…\n如果页面加载后仍未捕获，请打开工作区中的任一页面。无需发送 Agent 消息。');
      if (!timer) timer = setInterval(() => refresh().catch(fail), 800);
    } else { stopPolling(); if (pendingAction) { done(); notice('未捕获完整凭证，请确认已登录目标工作区，再重新提取。', true); } }
  } finally { polling = false; }
}
function fail(error) { stopPolling(); done(); notice(error.code ? syncMessage(error.code) : error.message, true); }
$('capture').onclick = async () => { try { pendingAction = 'download'; $('capture').disabled = true; await send('start'); await refresh(); } catch (error) { fail(error); } };
$('pair').onclick = async () => {
  if(pairing)return; pairing=true; $('pair').disabled=true;
  try {
    pendingOrigin = gatewayOrigin($('gateway').value.trim());
    if (!/^lgp-[a-f0-9]{64}$/.test($('pair-code').value.trim())) throw new Error('请先粘贴后台生成的完整配对码。');
    if (!await chrome.permissions.request({ origins: [permissionOrigin(pendingOrigin)] })) throw new Error('未获准连接该网关，尚未配对或传送凭证。');
    pendingAction = 'pair'; $('pair').disabled = true;
    if ((await send('status')).phase !== 'ready') await send('start');
    await refresh();
  } catch (error) { fail(error); }
};
$('download').onclick = () => download().catch(fail);
$('cancel').onclick = async () => { try { stopPolling(); done(); await send('cancel'); $('identity').hidden = true; await refresh(); notice('已取消并清除临时凭证。'); } catch (error) { fail(error); } };
$('sync-now').onclick = async () => { $('sync-now').disabled = true; try { notice('正在进行只读登录检查…'); await send('sync-now'); await loadBindings(); notice('已检查，请查看各账号的同步时间和状态。'); } catch (error) { fail(error); } finally { $('sync-now').disabled = false; } };
async function initialize() {
  if (!globalThis.chrome?.runtime?.sendMessage || !chrome.tabs?.query) throw new Error('请在 Chrome 或 Edge 安装此扩展后，从浏览器工具栏打开。');
  await loadBindings(); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id) || tab.incognito || !isLinearPage(tab.url)) { $('target').textContent = '请先打开已登录的 Linear 页面'; notice('提取或配对时，当前标签页需要是目标 Linear 工作区。', true); return; }
  tabId = tab.id; $('target').textContent = '当前页面：' + new URL(tab.url).pathname; $('capture').disabled = false; $('pair').disabled = false; await refresh();
}
initialize().catch(error => { $('target').textContent = '需要在浏览器扩展中打开'; notice(error.message, true); });

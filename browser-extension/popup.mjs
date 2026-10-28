import { isLinearPage } from './capture.mjs';

const $ = id => document.getElementById(id);
let tabId, timer, polling = false, automaticDownload = false;
function notice(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
async function send(type) {
  const result = await chrome.runtime.sendMessage({ type, tab_id: tabId });
  if (!result?.ok) throw new Error(result?.message ?? '提取工具未响应，请重新打开扩展。');
  return result.data;
}
function stopPolling() { clearInterval(timer); timer = undefined; }
async function download() {
  automaticDownload = false; stopPolling();
  const credential = await send('export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(credential, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'linear-session-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('download').hidden = true; $('cancel').hidden = true; $('capture').disabled = false;
  notice('JSON 已生成，扩展中的临时凭证已清除。\n接下来在网关账户后台导入下载的文件。');
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const state = await send('status');
    const waiting = state.phase === 'waiting', ready = state.phase === 'ready';
    $('capture').disabled = waiting;
    $('download').hidden = !ready; $('cancel').hidden = !waiting && !ready;
    $('identity').hidden = !ready;
    if (ready) {
      stopPolling(); $('user').textContent = state.user; $('organization').textContent = state.organization;
      notice('凭证已提取，可下载为网关支持的 JSON。');
      if (automaticDownload) await download();
    } else if (waiting) {
      notice('正在等待当前标签页的登录请求…\n如果页面加载后仍未捕获，请打开工作区中的任一页面。无需发送 Agent 消息。');
      if (!timer) timer = setInterval(() => refresh().catch(fail), 800);
    } else { stopPolling(); if (automaticDownload) { automaticDownload = false; notice('90 秒内未捕获完整凭证，请确认已登录目标工作区，再重新提取。', true); } }
  } finally { polling = false; }
}
function fail(error) { stopPolling(); automaticDownload = false; $('capture').disabled = false; notice(error.message, true); }
$('capture').onclick = async () => {
  $('capture').disabled = true; $('download').hidden = true; $('identity').hidden = true;
  try { automaticDownload = true; await send('start'); await refresh(); } catch (error) { fail(error); }
};
$('download').onclick = () => download().catch(fail);
$('cancel').onclick = async () => {
  try { automaticDownload = false; stopPolling(); await send('cancel'); $('identity').hidden = true; await refresh(); notice('已取消并清除临时凭证。'); } catch (error) { fail(error); }
};
async function initialize() {
  if (!globalThis.chrome?.runtime?.sendMessage || !chrome.tabs?.query) throw new Error('请在 Chrome 或 Edge 安装此扩展后，从浏览器工具栏打开。');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id) || tab.incognito || !isLinearPage(tab.url)) {
    $('target').textContent = '请先打开已登录的 Linear 页面';
    notice('当前标签页需要是 https://linear.app 中的目标工作区。', true); return;
  }
  tabId = tab.id; $('target').textContent = '当前页面：' + new URL(tab.url).pathname;
  $('capture').disabled = false; await refresh();
}
initialize().catch(error => { $('target').textContent = '需要在浏览器扩展中打开'; notice(error.message, true); });

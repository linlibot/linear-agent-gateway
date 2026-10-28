import { CaptureController, ENDPOINT } from './capture.mjs';
import { BrowserSync, gatewayOrigin, gatewayPost, permissionOrigin, probeLinear } from './sync.mjs';

const alarmName = 'linear-capture-expiry';
const controller = new CaptureController({
  read: async () => (await chrome.storage.session.get('capture')).capture ?? null,
  save: capture => chrome.storage.session.set({ capture }),
  clear: async () => { await chrome.storage.session.remove('capture'); await chrome.alarms.clear(alarmName); },
  expireAt: when => chrome.alarms.create(alarmName, { when }),
  reload: id => chrome.tabs.reload(id)
});
const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
const browserSync = new BrowserSync({
  read: async () => (await chrome.storage.local.get('bindings')).bindings ?? [],
  save: bindings => chrome.storage.local.set({ bindings }),
  post: (origin, route, body, token) => gatewayPost(origin, route, body, token, extensionOrigin),
  probe: async binding => {
    const tabs = await chrome.tabs.query({ url: 'https://linear.app/*' });
    const matching = tabs.filter(t => !t.incognito && (new URL(t.url).pathname === binding.workspace_path || new URL(t.url).pathname.startsWith(binding.workspace_path + '/')));
    const tab = matching.find(t => t.id === binding.tab_id) ?? matching[0];
    if (!tab) return { ok: false, code: 'waiting_browser' };
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: probeLinear, args: [{ user_id: binding.user_id, organization_id: binding.organization_id }] });
    return result[0]?.result ?? { ok: false, code: 'probe_failed' };
  }
});
async function ensureSyncAlarm() {
  if (!await chrome.alarms.get('linear-auto-sync')) await chrome.alarms.create('linear-auto-sync', { delayInMinutes: 1, periodInMinutes: 15 });
}
ensureSyncAlarm().catch(() => {});
chrome.runtime.onStartup.addListener(() => { ensureSyncAlarm().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { ensureSyncAlarm().catch(() => {}); });

chrome.webRequest.onSendHeaders.addListener(details => {
  controller.capture(details).catch(() => controller.cancel().catch(() => {}));
  browserSync.observe(details).catch(() => {});
}, { urls: [ENDPOINT], types: ['xmlhttprequest'] }, ['requestHeaders', 'extraHeaders']);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const action = async () => {
    if (message?.type === 'bindings') return browserSync.publicBindings();
    if (message?.type === 'unbind') { await browserSync.remove(message.id); return browserSync.publicBindings(); }
    if (message?.type === 'sync-now') { await browserSync.tick(); return browserSync.publicBindings(); }
    if (!Number.isInteger(message?.tab_id) || message.tab_id < 0) throw new Error('无法识别当前 Linear 标签页。');
    if (message.type === 'pair') {
      const origin = gatewayOrigin(message.gateway_origin);
      if (!await chrome.permissions.contains({ origins: [permissionOrigin(origin)] })) throw new Error('请先允许扩展连接你填写的网关地址。');
      const tab = await chrome.tabs.get(message.tab_id), credential = await controller.take(message.tab_id);
      return browserSync.bind(origin, message.pairing_code, credential, tab);
    }
    if (message.type === 'start') return controller.start(await chrome.tabs.get(message.tab_id));
    if (message.type === 'status') return controller.status(message.tab_id);
    if (message.type === 'export') return controller.take(message.tab_id);
    if (message.type === 'cancel') { await controller.cancel(message.tab_id); return { phase: 'idle' }; }
    throw new Error('不支持的操作。');
  };
  action().then(data => respond({ ok: true, data }), error => respond({ ok: false, message: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => { controller.cancel(id).catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === alarmName) controller.expire().catch(() => {});
  if (alarm.name === 'linear-auto-sync') browserSync.tick().catch(() => {});
});

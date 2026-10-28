import { CaptureController, ENDPOINT } from './capture.mjs';

const alarmName = 'linear-capture-expiry';
const controller = new CaptureController({
  read: async () => (await chrome.storage.session.get('capture')).capture ?? null,
  save: capture => chrome.storage.session.set({ capture }),
  clear: async () => { await chrome.storage.session.remove('capture'); await chrome.alarms.clear(alarmName); },
  expireAt: when => chrome.alarms.create(alarmName, { when }),
  reload: id => chrome.tabs.reload(id)
});

chrome.webRequest.onSendHeaders.addListener(details => {
  controller.capture(details).catch(() => controller.cancel().catch(() => {}));
}, { urls: [ENDPOINT], types: ['xmlhttprequest'] }, ['requestHeaders', 'extraHeaders']);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const action = async () => {
    if (!Number.isInteger(message?.tab_id) || message.tab_id < 0) throw new Error('无法识别当前 Linear 标签页。');
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
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) controller.expire().catch(() => {}); });

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const runtime = new URL('../.local-runtime/', import.meta.url);
const directory = (await fs.readFile(new URL('opus-pelican-directory.txt', runtime), 'utf8')).trim();
const reportFile = path.join(directory, 'generation-report.json');
const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
const browser = JSON.parse(await fs.readFile(path.join(directory, 'browser-validation.json'), 'utf8'));
const labels = { auto: '默认', low: '低', medium: '中', high: '高' };
const checks = [];
for (const effort of Object.keys(labels)) {
  const result = report.results.find(r => r.effort === effort);
  if (result?.status === 'failed') {
    if (!browser[effort]?.native_error_page_verified) throw new Error('Failure page was not verified: ' + effort);
    const jpg = await fs.readFile(path.join(directory, effort, 'failure.jpg'));
    if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('Expected a genuine error-page JPEG: ' + effort);
    checks.push({ effort, generation_failed: true, screenshot_bytes: jpg.length });
    result.browser_validation = browser[effort];
    continue;
  }
  if (result?.status !== 'generated' || !browser[effort]?.motion) throw new Error('Incomplete generation or browser verification: ' + effort);
  const html = await fs.readFile(path.join(directory, result.file));
  if (createHash('sha256').update(html).digest('hex') !== result.file_sha256) throw new Error('Generated HTML changed after extraction: ' + effort);
  const jpg = await fs.readFile(path.join(directory, effort, 'screenshot.jpg'));
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('Expected a genuine JPEG screenshot: ' + effort);
  checks.push({ effort, html_sha256_unchanged: true, screenshot_bytes: jpg.length });
  result.browser_validation = browser[effort];
}
report.delivery_checks = checks;
report.attempts_per_effort = Object.fromEntries(Object.keys(labels).map(effort => [effort, [...(report.attempt_history ?? []), ...report.results].filter(r => r.effort === effort).length]));
report.successful_samples_per_effort = Object.fromEntries(Object.keys(labels).map(effort => [effort, report.results.filter(r => r.effort === effort && r.status === 'generated').length]));
const nativeFailure = JSON.parse(await fs.readFile(new URL('opus-high-native.json', runtime), 'utf8'));
const firstHigh = report.attempt_history?.find(r => r.effort === 'high' && r.conversation_id === nativeFailure.aiConversation?.id);
if (firstHigh) firstHigh.native_failure_diagnostic = { status: nativeFailure.aiConversation.status, messages: nativeFailure.aiConversation.parts.filter(p => p.type === 'error').map(p => p.message) };
await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
const cards = Object.entries(labels).map(([effort, label]) => {
  const result = report.results.find(r => r.effort === effort);
  if (result.status === 'failed') {
    const attempts = [...(report.attempt_history ?? []), result].filter(r => r.effort === effort);
    return `<article><h2>${label} · ${effort} · 上游失败</h2><a href="${effort}/failure.jpg"><img src="${effort}/failure.jpg" alt="Linear 高档原始错误页截图"></a><p>${attempts.map(r => (r.duration_ms / 1000).toFixed(1) + ' 秒').join(' / ')} · ${attempts.length} 次均未生成 HTML</p><a href="${effort}/failure.jpg">查看 Linear 报错截图</a></article>`;
  }
  return `<article><h2>${label} · ${effort}</h2><a href="${effort}/index.html"><img src="${effort}/screenshot.jpg" alt="${label}档截图"></a><p>${(result.duration_ms / 1000).toFixed(1)} 秒 · ${(result.file_bytes / 1024).toFixed(1)} KiB</p><a href="${effort}/index.html">打开动画</a></article>`;
}).join('');
await fs.writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opus 5.5 · 鹈鹕骑车四档对照</title><style>body{margin:0;background:#f4f5f9;color:#242738;font:14px/1.7 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px}h1{font-size:26px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:#fff;border:1px solid #e0e3ed;border-radius:14px;padding:18px}img{display:block;width:100%;border-radius:8px}a{color:#595ec4}p{color:#6e7485}@media(max-width:650px){.grid{grid-template-columns:1fr}}</style><main><h1>Opus 5.5 · 鹈鹕骑自行车</h1><p>相同提示词，四个独立目录，每次请求使用全新对话，无历史消息和附件。成功三档各一个样本，高档两次上游失败。仍使用原有 Linear 商业工作区，未禁用工作区级指导。三份生成 HTML 均未人工修改。</p><p>模型名与档位为请求参数，上游实际模型身份和思考预算未得到独立确认；样本差异不能直接归因于档位。成品截图使用相同的浏览器窗口。</p><section class="grid">${cards}</section><p><a href="generation-report.json">生成记录</a> · <a href="browser-validation.json">浏览器检查记录</a></p></main></html>`);
console.log(JSON.stringify({ directory, verified: checks }));

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runtime = new URL('../.local-runtime/', import.meta.url);
const directory = path.resolve((await fs.readFile(new URL('sonnet-pelican-directory.txt', runtime), 'utf8')).trim());
if (path.dirname(directory) !== path.resolve(fileURLToPath(new URL('../outputs/', import.meta.url))) || !path.basename(directory).startsWith('sonnet-pelican-')) throw new Error('Unexpected generated run directory.');
const reportFile = path.join(directory, 'report.json');
const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
const browser = JSON.parse(await fs.readFile(path.join(directory, 'browser-validation.json'), 'utf8'));
const levels = { auto: ['默认', 'sonnet'], low: ['低', 'sonnet-low'], medium: ['中', 'sonnet-medium'], high: ['高', 'sonnet-high'] };
const checks = [];
for (const [effort, [, name]] of Object.entries(levels)) {
  const result = report.tests.find(t => t.name === name);
  if (result?.status !== 'success' || !browser[effort]?.motion) throw new Error('Incomplete generation or browser verification: ' + effort);
  const html = await fs.readFile(path.join(directory, result.file));
  if (createHash('sha256').update(html).digest('hex') !== result.file_sha256) throw new Error('Generated HTML changed after extraction: ' + effort);
  const jpg = await fs.readFile(path.join(directory, name, 'screenshot.jpg'));
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('Expected a genuine JPEG: ' + effort);
  checks.push({ effort, html_sha256_unchanged: true, screenshot_bytes: jpg.length });
  result.browser_validation = browser[effort];
}
const sonnetTests = Object.values(levels).map(([,name]) => report.tests.find(t => t.name === name));
if (new Set(sonnetTests.map(t => t.prompt_sha256)).size !== 1 || new Set(sonnetTests.map(t => t.conversation_id)).size !== 4) throw new Error('Expected one identical prompt and four distinct conversations.');
report.delivery_checks = checks;
await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
const cards = Object.entries(levels).map(([effort, [label, name]]) => {
  const result = report.tests.find(t => t.name === name);
  return `<article><h2>${label} · ${effort}</h2><a href="${name}/index.html"><img src="${name}/screenshot.jpg" alt="${label}档截图"></a><p>${(result.duration_ms / 1000).toFixed(1)} 秒 · ${(result.file_bytes / 1024).toFixed(1)} KiB</p><a href="${name}/index.html">打开原始动画</a></article>`;
}).join('');
const haiku = report.tests.find(t => t.name === 'haiku');
await fs.writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sonnet 5.5 · 鹈鹕骑车四档对照</title><style>body{margin:0;background:#f4f5f9;color:#242738;font:14px/1.7 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px}h1{font-size:26px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:#fff;border:1px solid #e0e3ed;border-radius:14px;padding:18px}img{display:block;width:100%;border-radius:8px}a{color:#595ec4}p{color:#6e7485}@media(max-width:650px){.grid{grid-template-columns:1fr}}</style><main><h1>Sonnet 5.5 · 鹈鹕骑自行车</h1><p>相同提示词，四个独立目录、全新对话，无历史消息和附件。仍使用原有 Linear 商业工作区。四份生成 HTML 均未人工修改。</p><p>模型名与档位为请求参数，上游实际模型身份和思考预算未得到独立确认；每档一个样本，差异不能直接归因于档位。</p><section class="grid">${cards}</section><p>Haiku 5.5 仅发送“你好”：${haiku?.status === 'success' ? '成功，' + (haiku.duration_ms / 1000).toFixed(1) + ' 秒' : '未成功'}。</p><p><a href="haiku/reply.txt">Haiku 原始回复</a> · <a href="report.json">生成记录</a> · <a href="browser-validation.json">浏览器检查</a></p></main></html>`);
console.log(JSON.stringify({ directory, verified: checks }));

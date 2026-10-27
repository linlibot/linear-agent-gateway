import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const family = process.argv[2];
const names = { opus: 'Opus 5.5', astra: 'GPT-6 Astra' };
if (!Object.hasOwn(names, family)) throw new Error('Choose an existing opus or astra pelican run.');
const name = names[family];
const runtime = new URL('../.local-runtime/', import.meta.url);
const directory = path.resolve((await fs.readFile(new URL(family + '-pelican-directory.txt', runtime), 'utf8')).trim());
const expectedRoot = path.resolve(process.cwd(), 'outputs');
if (path.dirname(directory) !== expectedRoot || !path.basename(directory).startsWith(family + '-pelican-')) throw new Error('Unexpected generated run directory.');
const levels = { auto: '默认', low: '低', medium: '中', high: '高' };
const artifact = (effort, kind) => path.join(directory, ...(family === 'opus' ? [effort, kind === 'html' ? 'index.html' : 'screenshot.jpg'] : [effort + (kind === 'html' ? '.html' : '.jpg')]));
const shellCsp = "default-src 'none'; frame-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const artCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
function html(res, body, csp = shellCsp) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(body); }
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const frame = url.pathname.match(/^\/art\/(auto|low|medium|high)$/);
    if (frame) {
      const result = JSON.parse(await fs.readFile(path.join(directory, 'generation-report.json'), 'utf8')).results.find(r => r.effort === frame[1]);
      if (result?.status === 'failed') return html(res, '<!doctype html><meta charset="utf-8"><title>本档生成失败</title><p>本档由 Linear 上游返回错误，未生成 HTML。</p><p><a href="/">返回四档结果</a></p>');
      return html(res, await fs.readFile(artifact(frame[1], 'html'), 'utf8'), artCsp);
    }
    const shot = url.pathname.match(/^\/shot\/(auto|low|medium|high)$/);
    if (shot) { const result = JSON.parse(await fs.readFile(path.join(directory, 'generation-report.json'), 'utf8')).results.find(r => r.effort === shot[1]); const file = family === 'opus' && result?.status === 'failed' ? path.join(directory, shot[1], 'failure.jpg') : artifact(shot[1], 'jpg'); const bytes = await fs.readFile(file); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(bytes); }
    const report = JSON.parse(await fs.readFile(path.join(directory, 'generation-report.json'), 'utf8'));
    if (url.pathname === '/') {
      const cards = Object.entries(levels).map(([effort, label]) => {
        const result = report.results.find(r => r.effort === effort);
        if (result?.status === 'failed') {
          const attempts = [...(report.attempt_history ?? []), result].filter(r => r.effort === effort);
          return `<article><h2>${label} · ${effort} · 上游失败</h2><a href="/shot/${effort}"><img src="/shot/${effort}" alt="Linear 原始错误页截图"></a><p>${attempts.map(r => (r.duration_ms / 1000).toFixed(1) + ' 秒').join(' / ')} · ${attempts.length} 次均未生成 HTML</p><a class="button" href="/shot/${effort}">查看 Linear 报错截图</a></article>`;
        }
        return `<article><h2>${label} · ${effort}</h2><a href="/art/${effort}"><img src="/shot/${effort}" alt="${label}档浏览器截图"></a><p>${result?.status === 'generated' ? (result.duration_ms / 1000).toFixed(1) + ' 秒 · ' + (result.file_bytes / 1024).toFixed(1) + ' KiB' : '尚未生成'}</p><a class="button" href="/art/${effort}">打开动画</a></article>`;
      }).join('');
      return html(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · 鹈鹕四档对照</title><style>body{margin:0;background:#f4f5f9;color:#242738;font:14px/1.7 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px}h1{font-size:26px;margin:0}p{color:#6e7485}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:#fff;border:1px solid #e0e3ed;border-radius:14px;padding:18px}h2{font-size:17px;margin:0 0 12px}img{display:block;width:100%;border-radius:8px;border:1px solid #e4e7ef}.button{display:inline-block;background:#5d60d5;color:white;padding:8px 14px;border-radius:7px;text-decoration:none}@media(max-width:650px){.grid{grid-template-columns:1fr}}</style><main><h1>${name} · 鹈鹕骑自行车</h1><p>同一提示词测试四档；成功三档各一个样本，高档两次上游失败。点击成功档截图查看动画。</p><p>每档独立本地目录、全新对话、无历史消息、无附件。仍使用原有 Linear 商业工作区，未禁用工作区级指导。成品绘图和动画逻辑未人工修改。</p><p>模型名与档位为请求参数，上游实际模型身份和思考预算未得到独立确认；本次样本差异不能直接归因于档位。</p><section class="grid">${cards}</section></main></html>`);
    }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Preview unavailable.'); }
});
server.listen(Number(process.env.LINEAR_ART_PREVIEW_PORT ?? 0), '127.0.0.1', async () => {
  const port = server.address().port;
  const data = { port, url: 'http://127.0.0.1:' + port, directory, pid: process.pid, policy: 'Only four generated HTML documents and their screenshots; sandboxed opaque frames; no external resource or network access.' };
  await fs.writeFile(new URL(family + '-pelican-preview.json', runtime), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data));
});

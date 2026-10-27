import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = new URL('../.local-runtime/', import.meta.url);
const directory = path.resolve((await fs.readFile(new URL('sonnet-pelican-directory.txt', runtime), 'utf8')).trim());
if (path.dirname(directory) !== path.resolve(fileURLToPath(new URL('../outputs/', import.meta.url))) || !path.basename(directory).startsWith('sonnet-pelican-')) throw new Error('Unexpected generated run directory.');
const levels = { auto: ['默认', 'sonnet'], low: ['低', 'sonnet-low'], medium: ['中', 'sonnet-medium'], high: ['高', 'sonnet-high'] };
const shellCsp = "default-src 'none'; frame-src 'self'; img-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const artCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
function html(res, body, csp = shellCsp) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(body); }
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const art = url.pathname.match(/^\/art\/(auto|low|medium|high)$/);
    if (art) return html(res, await fs.readFile(path.join(directory, levels[art[1]][1], 'index.html'), 'utf8'), artCsp);
    const shot = url.pathname.match(/^\/shot\/(auto|low|medium|high)$/);
    if (shot) { const bytes = await fs.readFile(path.join(directory, levels[shot[1]][1], 'screenshot.jpg')); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(bytes); }
    if (url.pathname !== '/') { res.writeHead(404); return res.end(); }
    const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
    const cards = Object.entries(levels).map(([effort, [label, name]]) => {
      const result = report.tests.find(t => t.name === name);
      if (result?.status === 'failed') return `<article><h2>${label} · ${effort}</h2><p>上游生成失败，未得到可验证的成品。</p></article>`;
      if (result?.status !== 'success') return `<article><h2>${label} · ${effort}</h2><p>生成中</p></article>`;
      return `<article><h2>${label} · ${effort}</h2><a href="/art/${effort}"><img src="/shot/${effort}" alt="${label}档浏览器截图"></a><p>${(result.duration_ms / 1000).toFixed(1)} 秒 · ${(result.file_bytes / 1024).toFixed(1)} KiB</p><a href="/art/${effort}">打开原始动画</a></article>`;
    }).join('');
    return html(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sonnet 5.5 · 鹈鹕四档对照</title><style>body{margin:0;background:#f4f5f9;color:#242738;font:14px/1.7 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px}h1{font-size:26px;margin:0}p{color:#6e7485}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:#fff;border:1px solid #e0e3ed;border-radius:14px;padding:18px}h2{font-size:17px;margin:0 0 12px}img{display:block;width:100%;border-radius:8px;border:1px solid #e4e7ef}a{color:#595ec4}@media(max-width:650px){.grid{grid-template-columns:1fr}}</style><main><h1>Sonnet 5.5 · 鹈鹕骑自行车</h1><p>默认 / 低 / 中 / 高，相同提示词，每档独立目录、全新对话，无历史消息和附件，继续使用原有 Linear 商业工作区。</p><p>原始成品未人工修改。模型名、档位为请求参数；实际底层模型及思考预算未得到独立确认，每档一个样本。</p><section class="grid">${cards}</section></main></html>`);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Preview unavailable.'); }
});
server.listen(Number(process.env.LINEAR_ART_PREVIEW_PORT ?? 0), '127.0.0.1', async () => {
  const port = server.address().port;
  const metadata = { port, url: 'http://127.0.0.1:' + port, directory, pid: process.pid, policy: 'Only four generated Sonnet HTML documents and screenshots; opaque sandbox; no external resources or network access.' };
  await fs.writeFile(new URL('sonnet-pelican-preview.json', runtime), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
});

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const runtime = new URL('../.local-runtime/', import.meta.url);
const directory = path.resolve((await fs.readFile(new URL('astra-pelican-directory.txt', runtime), 'utf8')).trim());
// Only a run created under this project's outputs directory can be previewed.
const expectedRoot = path.resolve(process.cwd(), 'outputs');
if (path.dirname(directory) !== expectedRoot || !path.basename(directory).startsWith('astra-pelican-')) throw new Error('Unexpected generated run directory.');
const levels = { auto: '默认', low: '低', medium: '中', high: '高' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const shellCsp = "default-src 'none'; frame-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const artCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
function html(res, body, csp = shellCsp) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(body); }
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const frame = url.pathname.match(/^\/art\/(auto|low|medium|high)$/);
    if (frame) return html(res, await fs.readFile(path.join(directory, frame[1] + '.html'), 'utf8'), artCsp);
    const shot = url.pathname.match(/^\/shot\/(auto|low|medium|high)$/);
    if (shot) { const bytes = await fs.readFile(path.join(directory, shot[1] + '.jpg')); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(bytes); }
    const report = JSON.parse(await fs.readFile(path.join(directory, 'generation-report.json'), 'utf8'));
    if (url.pathname === '/') {
      const cards = Object.entries(levels).map(([effort, label]) => { const result = report.results.find(r => r.effort === effort); return `<article><h2>${label} · ${effort}</h2><a href="/view/${effort}"><img src="/shot/${effort}" alt="${label}档浏览器截图"></a><p>${result?.status === 'generated' ? (result.duration_ms / 1000).toFixed(1) + ' 秒 · ' + (result.file_bytes / 1024).toFixed(1) + ' KiB' : '生成中'}</p><a class="button" href="/view/${effort}">打开动画</a></article>`; }).join('');
      return html(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Astra 鹈鹕骑车 · 四档对照</title><style>body{margin:0;background:#f4f5f9;color:#242738;font:14px/1.7 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px}h1{font-size:26px;margin:0}p{color:#6e7485}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:#fff;border:1px solid #e0e3ed;border-radius:14px;padding:18px}h2{font-size:17px;margin:0 0 12px}img{display:block;width:100%;border-radius:8px;border:1px solid #e4e7ef}.button{display:inline-block;background:#5d60d5;color:white;padding:8px 14px;border-radius:7px;text-decoration:none}@media(max-width:650px){.grid{grid-template-columns:1fr}h1{font-size:23px}}</style><main><h1>GPT-6 Astra · 鹈鹕骑自行车</h1><p>相同提示词，默认 / 低 / 中 / 高各生成一次。点击截图查看动画。</p><p>四份成品均未人工修改绘图与动画逻辑；默认档已恢复网关富文本格式。每档只有一个样本，画面差异不能直接归因于思考强度。</p><section class="grid">${cards}</section></main></html>`);
    }
    const match = url.pathname.match(/^\/view\/(auto|low|medium|high)$/);
    if (!match) { res.writeHead(404); return res.end(); }
    const effort = match[1], label = levels[effort], result = report.results.find(r => r.effort === effort);
    if (!result || result.status !== 'generated') { res.writeHead(404); return res.end('This sample has not been generated.'); }
    return html(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Astra · ${label}档 · 鹈鹕骑车</title><style>*{box-sizing:border-box}body{margin:0;background:#eef0f6;color:#222737;font:13px/1.6 system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:16px}header{display:flex;align-items:center;gap:10px;justify-content:space-between}h1{font-size:19px;margin:0}.meta{color:#70778a;font-size:12px;margin:7px 0 13px}a{color:#595ec4;text-decoration:none}#stage{width:100%;overflow:hidden;background:white;border-radius:10px;border:1px solid #dce0eb}iframe{display:block;width:1200px;height:800px;border:0;transform-origin:top left}.footer{color:#808697;font-size:11px;margin-top:10px}</style><main><header><h1>GPT-6 Astra · ${label}档</h1><a href="/">四档总览</a></header><div class="meta">请求档位：${escape(effort)} · 生成 ${(result.duration_ms / 1000).toFixed(1)} 秒 · HTML ${(result.file_bytes / 1024).toFixed(1)} KiB</div><div id="stage"><iframe title="${label}档鹈鹕动画" sandbox="allow-scripts" src="/art/${effort}"></iframe></div><div class="footer">统一 1200 × 800 页面视窗，按当前面板宽度等比展示。${result.gateway_format_recovery ? '已恢复网关富文本格式；绘图与动画逻辑未修改。' : '原始 HTML 未改写。'}</div></main><script>const stage=document.getElementById('stage'),frame=stage.querySelector('iframe');function fit(){const scale=Math.min(1,stage.clientWidth/1200);frame.style.transform='scale('+scale+')';stage.style.height=(800*scale)+'px';}addEventListener('resize',fit);fit();</script></html>`);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Preview unavailable.'); }
});
server.listen(Number(process.env.LINEAR_ART_PREVIEW_PORT ?? 0), '127.0.0.1', async () => {
  const port = server.address().port;
  const data = { port, url: 'http://127.0.0.1:' + port, directory, pid: process.pid, policy: 'Only four generated HTML documents and their screenshots; sandboxed opaque frames; no external resource or network access.' };
  await fs.writeFile(new URL('astra-pelican-preview.json', runtime), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data));
});

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { AccountStore } from '../accounts.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const root = new URL('../outputs/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const directory = await fs.mkdtemp(new URL('astra-pelican-', root));
const dir = new URL('./', 'file:///' + directory.replaceAll('\\', '/') + '/');
const { api_key } = JSON.parse(await fs.readFile(new URL('access.json', runtime), 'utf8'));
const account = await new AccountStore(runtime).resolve();
const base = `http://127.0.0.1:${process.env.LINEAR_PORT ?? 8089}`;
const model = 'openai/gpt-6-astra';
const prompt = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。\n请只输出一份完整、可直接本地打开的 HTML 代码，所有 SVG、CSS、JavaScript 内联，不引用外部库或图片。请直接在回复中给代码，不创建工作区条目或启动 coding session。';
const report = { startedAt: new Date().toISOString(), requested_model: model, actual_model_identity_verified: false, actual_reasoning_budget_verified: false,
  prompt, prompt_sha256: createHash('sha256').update(prompt).digest('hex'), account_id: account.id,
  generation_order: ['medium', 'auto', 'high', 'low'], independent_conversations: true, files_unedited_after_extraction: true, samples_per_effort: 1, results: [] };
await fs.writeFile(new URL('astra-pelican-directory.txt', runtime), directory);
async function persist() { await fs.writeFile(new URL('generation-report.json', dir), JSON.stringify(report, null, 2)); }
await persist();
console.log(JSON.stringify({ phase: 'begin', directory, model, prompt_sha256: report.prompt_sha256 }));
const catalogResponse = await fetch(base + '/v1/models?account_id=' + account.id, { headers: { authorization: 'Bearer ' + api_key }, signal: AbortSignal.timeout(10000) });
const catalog = await catalogResponse.json();
if (!catalogResponse.ok || !catalog.data?.some(m => m.id === model)) throw new Error('The selected account does not have the tested GPT-6 Astra parameter.');

for (const effort of report.generation_order) {
  const started = performance.now();
  const result = { effort, requested_model: model, prompt_sha256: report.prompt_sha256, startedAt: new Date().toISOString() };
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, account_id: account.id, ...(effort === 'auto' ? {} : { reasoning_effort: effort }), stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(190000),
    });
    const body = await response.text();
    Object.assign(result, { http_status: response.status, duration_ms: Math.round(performance.now() - started), conversation_id: response.headers.get('x-linear-conversation-id'), response_effort: response.headers.get('x-linear-requested-reasoning-effort'), response_model_parameter: response.headers.get('x-linear-requested-model') });
    if (!response.ok) throw new Error('Gateway rejected request: ' + response.status);
    const events = body.split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
    const chunks = events.filter(e => e !== '[DONE]').map(JSON.parse);
    if (events.at(-1) !== '[DONE]' || chunks.some(c => c.error) || !chunks.some(c => c.choices?.some(v => v.finish_reason === 'stop'))) throw new Error('Generation stream did not complete successfully.');
    const text = chunks.flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? '').join('');
    await fs.writeFile(new URL(effort + '-reply.txt', dir), text);
    result.reply_characters = text.length;
    const start = text.search(/<!doctype html|<html[\s>]/i), end = text.toLowerCase().lastIndexOf('</html>');
    if (start < 0 || end < start) throw new Error('The original reply did not include a complete HTML document.');
    const html = text.slice(start, end + 7);
    if (!/<svg[\s>]/i.test(html)) throw new Error('The original reply did not include SVG.');
    const file = effort + '.html';
    await fs.writeFile(new URL(file, dir), html);
    const scriptChecks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/type\s*=\s*["']application\//i.test(m[1])).map((m, index) => {
      try { new vm.Script(m[2]); return { index, syntax: 'ok' }; } catch (error) { return { index, syntax: 'needs_browser_check', message: error.message }; }
    });
    Object.assign(result, { file, file_bytes: Buffer.byteLength(html), file_sha256: createHash('sha256').update(html).digest('hex'), contains_animation_code: /@keyframes|<animate|requestAnimationFrame|\.animate\(/i.test(html), script_checks: scriptChecks,
      external_resource_references: [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi)].map(m => m[1]), status: 'generated' });
  } catch (error) { result.status = 'failed'; result.error = error.message; result.duration_ms = Math.round(performance.now() - started); }
  report.results.push(result); await persist();
  console.log(JSON.stringify(result));
}
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ phase: 'complete', directory: fileURLToPath(dir), generated: report.results.filter(r => r.status === 'generated').length }));

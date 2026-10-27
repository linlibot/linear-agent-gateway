import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { AccountStore } from '../accounts.mjs';
import { LinearClient, normalizeSession, READ_QUERY } from '../upstream.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const root = new URL('../outputs/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const retryFailed = process.argv.includes('--retry-failed');
const directory = retryFailed ? (await fs.readFile(new URL('opus-pelican-directory.txt', runtime), 'utf8')).trim() : await fs.mkdtemp(new URL('opus-pelican-', root));
if (path.dirname(path.resolve(directory)) !== path.resolve(fileURLToPath(root)) || !path.basename(directory).startsWith('opus-pelican-')) throw new Error('Unexpected run directory.');
const { api_key } = JSON.parse(await fs.readFile(new URL('access.json', runtime), 'utf8'));
const account = await new AccountStore(runtime).resolve();
const client = new LinearClient(normalizeSession(account.session));
const priorConversations = new Set(Object.keys(JSON.parse(await fs.readFile(new URL('conversation-accounts.json', runtime), 'utf8'))));
const base = `http://127.0.0.1:${process.env.LINEAR_PORT ?? 8089}`;
const model = 'anthropic/claude-opus-5-5';
const prompt = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。\n请只输出一份完整、可直接本地打开的 HTML 代码，所有 SVG、CSS、JavaScript 内联，不引用外部库或图片。请直接在回复中给代码，不创建工作区条目或启动 coding session。';
const previousReport = retryFailed ? JSON.parse(await fs.readFile(path.join(directory, 'generation-report.json'), 'utf8')) : null;
if (previousReport && (previousReport.account_id !== account.id || previousReport.prompt !== prompt || previousReport.requested_model !== model)) throw new Error('Retry configuration differs from the original run.');
const order = previousReport ? previousReport.results.filter(r => r.status === 'failed').map(r => r.effort) : ['auto', 'low', 'medium', 'high'];
for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
const report = previousReport ?? {
  startedAt: new Date().toISOString(), requested_model: model, actual_model_identity_verified: false,
  actual_reasoning_budget_verified: false, prompt, prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
  account_id: account.id, generation_order: order, independent_conversations: true,
  files_unedited_after_extraction: true, samples_per_effort: 1,
  isolation: {
    separate_local_directory_per_effort: true, new_conversation_per_effort: true,
    messages_per_request: 1, previous_messages_or_artifacts_sent: false, upstream_explicit_context: [],
    same_linear_workspace: true, workspace_guidance_disabled: false,
    backend_cross_chat_memory_absence_verified: false,
    note: 'Fresh chat and empty explicit context isolate supplied conversation history. Local files are never uploaded. This is not a separate Linear organization and does not disable server-side workspace/personal guidance.'
  }, results: []
};
if (previousReport) {
  report.attempt_history ??= [];
  report.attempt_history.push(...report.results.filter(r => order.includes(r.effort)));
  report.results = report.results.filter(r => !order.includes(r.effort));
  report.retry_order = order;
}
for (const effort of order) {
  await fs.mkdir(path.join(directory, effort), { recursive: true });
  await fs.writeFile(path.join(directory, effort, 'prompt.txt'), prompt);
}
await fs.writeFile(new URL('opus-pelican-directory.txt', runtime), directory);
async function persist() { await fs.writeFile(path.join(directory, 'generation-report.json'), JSON.stringify(report, null, 2)); }
await persist();
console.log(JSON.stringify({ phase: 'begin', directory, model, order, prompt_sha256: report.prompt_sha256 }));
const catalogResponse = await fetch(base + '/v1/models?account_id=' + account.id, { headers: { authorization: 'Bearer ' + api_key }, signal: AbortSignal.timeout(10000) });
const catalog = await catalogResponse.json();
if (!catalogResponse.ok || !catalog.data?.some(m => m.id === model)) throw new Error('The selected account does not have the previously tested Opus 5.5 model parameter.');

for (const effort of order) {
  const started = performance.now();
  const result = { effort, requested_model: model, prompt_sha256: report.prompt_sha256, startedAt: new Date().toISOString(), isolated_directory: effort };
  const out = filename => path.join(directory, effort, filename);
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, account_id: account.id, ...(effort === 'auto' ? {} : { reasoning_effort: effort }), stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(190000),
    });
    const body = await response.text();
    Object.assign(result, { http_status: response.status, duration_ms: Math.round(performance.now() - started), conversation_id: response.headers.get('x-linear-conversation-id'), response_effort: response.headers.get('x-linear-requested-reasoning-effort'), response_model_parameter: response.headers.get('x-linear-requested-model') });
    if (!response.ok) throw new Error('Gateway rejected request: ' + response.status);
    if (priorConversations.has(result.conversation_id) || report.results.some(r => r.conversation_id === result.conversation_id)) throw new Error('A conversation was reused unexpectedly.');
    if (result.response_model_parameter !== model || result.response_effort !== effort) throw new Error('Unexpected model or effort response metadata.');
    const events = body.split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
    const chunks = events.filter(e => e !== '[DONE]').map(JSON.parse);
    const upstreamErrors = chunks.filter(c => c.error).map(c => c.error);
    if (upstreamErrors.length) result.stream_errors = upstreamErrors;
    if (events.at(-1) !== '[DONE]' || chunks.some(c => c.error) || !chunks.some(c => c.choices?.some(v => v.finish_reason === 'stop'))) throw new Error('Generation stream did not complete successfully.');
    const text = chunks.flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? '').join('');
    await fs.writeFile(out('reply.txt'), text);
    result.reply_characters = text.length;
    const start = text.search(/<!doctype html|<html[\s>]/i), end = text.toLowerCase().lastIndexOf('</html>');
    if (start < 0 || end < start) throw new Error('The original reply did not include a complete HTML document.');
    const html = text.slice(start, end + 7);
    if (!/<svg[\s>]/i.test(html)) throw new Error('The original reply did not include SVG.');
    await fs.writeFile(out('index.html'), html);
    const scriptChecks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/type\s*=\s*["']application\//i.test(m[1])).map((m, index) => {
      try { new vm.Script(m[2]); return { index, syntax: 'ok' }; } catch (error) { return { index, syntax: 'needs_browser_check', message: error.message }; }
    });
    Object.assign(result, { file: effort + '/index.html', file_bytes: Buffer.byteLength(html), file_sha256: createHash('sha256').update(html).digest('hex'), contains_animation_code: /@keyframes|<animate|requestAnimationFrame|\.animate\(/i.test(html), script_checks: scriptChecks,
      external_resource_references: [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi)].map(m => m[1]), status: 'generated' });
    try {
      const { aiConversation } = await client.call(READ_QUERY, { id: result.conversation_id }, AbortSignal.timeout(20000));
      result.native_part_type_counts = Object.fromEntries([...new Set(aiConversation.parts.map(p => p.type))].map(type => [type, aiConversation.parts.filter(p => p.type === type).length]));
      result.native_tool_calls = aiConversation.parts.filter(p => p.type === 'toolCall').length;
    } catch { result.native_part_audit = 'unavailable'; }
  } catch (error) { result.status = 'failed'; result.error = error.message; result.duration_ms = Math.round(performance.now() - started); }
  report.results.push(result); await persist();
  console.log(JSON.stringify(result));
}
report.finishedAt = new Date().toISOString(); await persist();
console.log(JSON.stringify({ phase: 'complete', directory, generated: report.results.filter(r => r.status === 'generated').length }));

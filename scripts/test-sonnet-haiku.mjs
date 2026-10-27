import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { AccountStore } from '../accounts.mjs';
import { LinearClient, normalizeSession, READ_QUERY } from '../upstream.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const account = await new AccountStore(runtime).resolve();
const client = new LinearClient(normalizeSession(account.session));
const { api_key } = JSON.parse(await fs.readFile(new URL('access.json', runtime), 'utf8'));
const base = `http://127.0.0.1:${process.env.LINEAR_PORT ?? 8089}`;
const remainingEfforts = process.argv.includes('--all-efforts');
const directory = remainingEfforts ? (await fs.readFile(new URL('sonnet-pelican-directory.txt', runtime), 'utf8')).trim() : await fs.mkdtemp(new URL('../outputs/sonnet-pelican-', import.meta.url));
if (path.dirname(path.resolve(directory)) !== path.resolve(fileURLToPath(new URL('../outputs/', import.meta.url))) || !path.basename(directory).startsWith('sonnet-pelican-')) throw new Error('Unexpected test run directory.');
const originalCases = [
  { name: 'haiku', model: 'anthropic/claude-haiku-5-5', prompt: '你好' },
  { name: 'sonnet', model: 'anthropic/claude-sonnet-5-5', prompt: '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。\n请只输出一份完整、可直接本地打开的 HTML 代码，所有 SVG、CSS、JavaScript 内联，不引用外部库或图片。请直接在回复中给代码，不创建工作区条目或启动 coding session。' },
];
const report = remainingEfforts ? JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')) : { startedAt: new Date().toISOString(), account_id: account.id, actual_model_identity_verified: false, requested_reasoning_effort: null, reasoning_effort_verified: false,
  isolation: { new_conversation_per_request: true, separate_local_directory_per_case: true, previous_messages_or_artifacts_sent: false, explicit_context: [], same_linear_workspace: true }, tests: [] };
if (report.account_id !== account.id) throw new Error('Test run account mismatch.');
const extra = ['low', 'medium', 'high'];
for (let i = extra.length - 1; i > 0; i--) { const j = randomInt(i + 1); [extra[i], extra[j]] = [extra[j], extra[i]]; }
const cases = remainingEfforts ? [originalCases[1], ...extra.map(effort => ({ ...originalCases[1], name: 'sonnet-' + effort, effort }))].filter(c => !report.tests.some(t => t.name === c.name && t.status === 'success')) : originalCases;
report.generation_order ??= report.tests.filter(t => t.name !== 'haiku').map(t => t.requested_reasoning_effort ?? 'auto');
await fs.writeFile(new URL('sonnet-pelican-directory.txt', runtime), directory);
const persist = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
await persist();
console.log(JSON.stringify({ phase: 'begin', directory, cases }));
for (const testCase of cases) {
  const caseDirectory = path.join(directory, testCase.name);
  await fs.mkdir(caseDirectory, { recursive: true });
  await fs.writeFile(path.join(caseDirectory, 'prompt.txt'), testCase.prompt);
  const previous = report.tests.find(t => t.name === testCase.name);
  if (previous) { report.attempt_history ??= []; report.attempt_history.push(previous); report.tests = report.tests.filter(t => t.name !== testCase.name); }
  if (testCase.name !== 'haiku') report.generation_order.push(testCase.effort ?? 'auto');
  const result = { name: testCase.name, requested_model: testCase.model, requested_reasoning_effort: testCase.effort ?? null, prompt: testCase.prompt, prompt_sha256: createHash('sha256').update(testCase.prompt).digest('hex'), actual_model_identity_verified: false, files_unedited_after_extraction: true, reply_received: false };
  const started = performance.now();
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: testCase.model, account_id: account.id, ...(testCase.effort ? { reasoning_effort: testCase.effort } : {}), stream: true, messages: [{ role: 'user', content: testCase.prompt }] }),
      signal: AbortSignal.timeout(190000)
    });
    Object.assign(result, { http_status: response.status, conversation_id: response.headers.get('x-linear-conversation-id'), response_effort: response.headers.get('x-linear-requested-reasoning-effort'), response_model_parameter: response.headers.get('x-linear-requested-model') });
    const body = await response.text();
    result.duration_ms = Math.round(performance.now() - started);
    if (!response.ok) throw new Error('Gateway rejected request: ' + response.status);
    if (result.response_model_parameter !== testCase.model || result.response_effort !== (testCase.effort ?? 'auto')) throw new Error('Unexpected model or effort response metadata.');
    const events = body.split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
    const chunks = events.filter(e => e !== '[DONE]').map(JSON.parse);
    const errors = chunks.filter(c => c.error).map(c => c.error);
    if (errors.length) result.stream_errors = errors;
    if (events.at(-1) !== '[DONE]' || errors.length || !chunks.some(c => c.choices?.some(v => v.finish_reason === 'stop'))) throw new Error('Generation stream did not complete successfully.');
    const text = chunks.flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? '').join('');
    await fs.writeFile(path.join(caseDirectory, 'reply.txt'), text);
    result.reply_received = Boolean(text.trim());
    result.reply_characters = text.length;
    if (testCase.name === 'haiku') result.reply_text = text;
    else {
      const start = text.search(/<!doctype html|<html[\s>]/i), end = text.toLowerCase().lastIndexOf('</html>');
      if (start < 0 || end < start) throw new Error('The original reply did not include a complete HTML document.');
      const html = text.slice(start, end + 7);
      if (!/<svg[\s>]/i.test(html)) throw new Error('The original reply did not include SVG.');
      await fs.writeFile(path.join(caseDirectory, 'index.html'), html);
      Object.assign(result, { file: testCase.name + '/index.html', file_bytes: Buffer.byteLength(html), file_sha256: createHash('sha256').update(html).digest('hex'), contains_animation_code: /@keyframes|<animate|requestAnimationFrame|\.animate\(/i.test(html),
        external_resource_references: [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi)].map(m => m[1]),
        script_checks: [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/type\s*=\s*["']application\//i.test(m[1])).map((m, index) => {
          try { new vm.Script(m[2]); return { index, syntax: 'ok' }; } catch (error) { return { index, syntax: 'needs_browser_check', message: error.message }; }
        }) });
    }
    result.status = 'success';
  } catch (error) { result.status = 'failed'; result.error = error.message; result.duration_ms = Math.round(performance.now() - started); }
  if (result.conversation_id) {
    try {
      const { aiConversation } = await client.call(READ_QUERY, { id: result.conversation_id }, AbortSignal.timeout(15000));
      result.native_status = aiConversation.status;
      result.native_error_messages = aiConversation.parts.filter(p => p.type === 'error').map(p => p.message);
      result.native_part_type_counts = Object.fromEntries([...new Set(aiConversation.parts.map(p => p.type))].map(type => [type, aiConversation.parts.filter(p => p.type === type).length]));
      result.native_tool_calls = aiConversation.parts.filter(p => p.type === 'toolCall').length;
    } catch { result.native_audit_unavailable = true; }
  }
  report.tests.push(result);
  await persist();
  console.log(JSON.stringify(result));
}
report.finishedAt = new Date().toISOString(); await persist();
console.log(JSON.stringify({ phase: 'complete', directory, successful: report.tests.filter(t => t.status === 'success').length }));

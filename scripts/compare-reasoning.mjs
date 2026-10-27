import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AccountStore } from '../accounts.mjs';
import { LinearClient, normalizeSession, READ_QUERY } from '../upstream.mjs';
import { summarizeReasoning } from './reasoning-summary.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const output = new URL('../outputs/', import.meta.url);
const model = process.env.LINEAR_TEST_MODEL ?? 'openai/gpt-6.1-sol';
const repetitions = Number(process.env.LINEAR_COMPARE_REPEATS ?? 2);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('LINEAR_COMPARE_REPEATS must be 1, 2 or 3.');
const { api_key } = JSON.parse(await fs.readFile(new URL('access.json', runtime), 'utf8'));
const account = await new AccountStore(runtime).resolve({ accountId: process.env.LINEAR_ACCOUNT_ID });
const client = new LinearClient(normalizeSession(account.session));
const base = `http://127.0.0.1:${process.env.LINEAR_PORT ?? 8089}`;
const levels = ['auto', 'low', 'medium', 'high'];

// Ground truth uses local exact computation; no answer is included in model prompts.
const blocked = new Set(['2,2', '3,5', '5,3', '6,6']);
function paths(x0, y0, x1, y1) {
  const dp = new Map();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const key = `${x},${y}`;
    dp.set(key, blocked.has(key) ? 0 : x === x0 && y === y0 ? 1 : (dp.get(`${x - 1},${y}`) ?? 0) + (dp.get(`${x},${y - 1}`) ?? 0));
  }
  return dp.get(`${x1},${y1}`);
}
function trace() {
  let a = [3, 1, 4, 1, 5, 9];
  for (let r = 0; r < 7; r++) {
    const old = a.slice();
    a = old.map((v, i) => (v + old[(i + 1) % old.length] * (r + 2) + i) % 97);
    if (r % 2 === 0) a.reverse();
    else a.push(a.shift());
  }
  return { a, checksum: a.reduce((s, v, i) => s + v * (i + 1), 0) };
}
const items = [
  ['A', 4, 15], ['B', 6, 21], ['C', 3, 11], ['D', 7, 25], ['E', 5, 17], ['F', 2, 8],
  ['G', 8, 28], ['H', 4, 14], ['I', 6, 22], ['J', 3, 12], ['K', 5, 19], ['L', 2, 7],
];
function knapsack() {
  let best = -1, optimal = [];
  for (let mask = 0; mask < 1 << items.length; mask++) {
    const chosen = items.filter((_, i) => (mask >> i) & 1);
    const names = chosen.map(i => i[0]);
    if (chosen.length !== 5 || chosen.reduce((s, i) => s + i[1], 0) > 23) continue;
    if (names.includes('A') && names.includes('D')) continue;
    if (names.includes('B') && names.includes('I')) continue;
    if (names.includes('C') && !names.includes('J')) continue;
    if (names.includes('G') && names.includes('K')) continue;
    const value = chosen.reduce((s, i) => s + i[2], 0);
    if (value > best) { best = value; optimal = [names.join('')]; }
    else if (value === best) optimal.push(names.join(''));
  }
  optimal.sort();
  return { value: best, selection: optimal[0], optimal_count: optimal.length };
}
const preamble = '这是一道独立推理测试。请直接解题，无需访问工作区或外部资料。只返回题目要求的最终 JSON，不解释过程。\n\n';
const tasks = [
  { id: 'grid_paths', prompt: '在整数格点上从(0,0)到(8,8)，每步只能向右(1,0)或向上(0,1)。必须经过(4,4)，且不能经过(2,2)、(3,5)、(5,3)、(6,6)。有多少条不同路径？返回 {"paths":整数}。', expected: { paths: paths(0, 0, 4, 4) * paths(4, 4, 8, 8) } },
  { id: 'code_trace', prompt: '按 JavaScript 语义执行以下代码（map 的每个元素都从同一份 old 读取），给出最终 a 和 checksum。返回 {"a":[整数...],"checksum":整数}。\nlet a=[3,1,4,1,5,9];\nfor(let r=0;r<7;r++){\n const old=a.slice();\n a=old.map((v,i)=>(v+old[(i+1)%old.length]*(r+2)+i)%97);\n if(r%2===0)a.reverse();else a.push(a.shift());\n}\nconst checksum=a.reduce((s,v,i)=>s+v*(i+1),0);', expected: trace() },
  { id: 'constrained_knapsack', prompt: '每件物品至多选一次。物品(名称,重量,价值)：' + items.map(i => `(${i.join(',')})`).join('、') + '。恰好选5件，总重量不超过23。A与D不能同时选；B与I不能同时选；选C必须选J；G与K不能同时选。求最大总价值 value、达到最大值的不同选择数量 optimal_count，并将字母升序连成字符串，给出字典序最小的最优选择 selection。返回 {"value":整数,"selection":"字母串","optimal_count":整数}。', expected: knapsack() },
].map(task => ({ ...task, prompt: preamble + task.prompt }));

// A fixed shuffle seed makes ordering reproducible, without pretending to set model sampling.
let rng = 0x4c494e45;
function random() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; }
function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
const schedule = [];
for (let repetition = 1; repetition <= repetitions; repetition++) for (const task of shuffled(tasks)) for (const effort of shuffled(levels)) schedule.push({ task, repetition, effort });
function jsonAnswer(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
function matches(actual, expected) {
  return actual !== null && Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
}
const report = {
  startedAt: new Date().toISOString(), model_parameter: model, actual_model_identity_verified: false, actual_reasoning_budget_verified: false,
  account_id: account.id, design: { independent_conversations: true, repetitions, task_count: tasks.length, calls_planned: schedule.length, shuffled_order_seed: '0x4c494e45', native_temperature_or_seed_control: false, default_omits_reasoning_effort: true, polling_interval_note: 'Gateway polls about every 1.5 seconds. Timings include service and polling overhead; accepted-to-complete is not pure model thinking time.' },
  tasks: tasks.map(task => ({ id: task.id, prompt: task.prompt, expected: task.expected, prompt_sha256: createHash('sha256').update(task.prompt).digest('hex') })), runs: [], summary: [],
};
await fs.mkdir(output, { recursive: true });
async function persist() {
  report.updatedAt = new Date().toISOString();
  Object.assign(report, summarizeReasoning(report));
  await fs.writeFile(new URL('reasoning-comparison.json', runtime), JSON.stringify(report, null, 2));
  await fs.writeFile(new URL('reasoning-comparison.json', output), JSON.stringify(report, null, 2));
}
await persist();
for (const [index, { task, repetition, effort }] of schedule.entries()) {
  const started = performance.now();
  const run = { index: index + 1, task: task.id, repetition, effort, startedAt: new Date().toISOString(), prompt_sha256: report.tasks.find(t => t.id === task.id).prompt_sha256 };
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, account_id: account.id, ...(effort === 'auto' ? {} : { reasoning_effort: effort }), stream: true, messages: [{ role: 'user', content: task.prompt }] }),
      signal: AbortSignal.timeout(190000),
    });
    const accepted = performance.now();
    Object.assign(run, { http_status: response.status, conversation_id: response.headers.get('x-linear-conversation-id'), accepted_ms: Math.round(accepted - started), response_effort: response.headers.get('x-linear-requested-reasoning-effort') });
    const body = await response.text();
    const completed = performance.now();
    Object.assign(run, { total_ms: Math.round(completed - started), after_accept_ms: Math.round(completed - accepted) });
    if (!response.ok) { run.error_code = jsonAnswer(body)?.error?.code ?? 'http_error'; }
    else {
      const events = body.split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
      const chunks = events.filter(e => e !== '[DONE]').map(JSON.parse);
      const error = chunks.find(chunk => chunk.error)?.error;
      run.finished = !error && events.at(-1) === '[DONE]' && chunks.some(chunk => chunk.choices?.some(c => c.finish_reason === 'stop'));
      if (error) run.error_code = error.code;
      run.reply = chunks.flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? '').join('');
      run.reply_characters = run.reply.length;
      run.parsed_answer = jsonAnswer(run.reply);
      run.correct = run.finished && matches(run.parsed_answer, task.expected);
    }
    if (run.conversation_id) {
      try {
        const { aiConversation } = await client.call(READ_QUERY, { id: run.conversation_id }, AbortSignal.timeout(15000));
        run.tool_calls = (aiConversation?.parts ?? []).filter(p => p.type === 'toolCall').length;
        run.conversation_status = aiConversation?.status;
      } catch (error) { run.metadata_read_error = error.code ?? error.name; }
    }
  } catch (error) { run.error_code = error.code ?? error.name; run.total_ms = Math.round(performance.now() - started); }
  report.runs.push(run);
  await persist();
  console.log(JSON.stringify({ progress: `${index + 1}/${schedule.length}`, task: run.task, repetition, effort, correct: run.correct ?? null, total_ms: run.total_ms, after_accept_ms: run.after_accept_ms, tool_calls: run.tool_calls, error_code: run.error_code }));
  if (run.error_code === 'linear_session_expired' || run.http_status === 429) { report.stopped_reason = run.error_code ?? 'rate_limit'; break; }
}
report.finishedAt = new Date().toISOString();
report.completed_plan = report.runs.length === schedule.length;
await persist();
console.log(JSON.stringify({ phase: 'summary', completed_plan: report.completed_plan, summary: report.summary }));

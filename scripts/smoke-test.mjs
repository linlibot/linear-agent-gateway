import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openAdminSession } from './admin-session.mjs';
import { readConfig } from '../config.mjs';

const { api_key } = JSON.parse(await fs.readFile(new URL('../.local-runtime/access.json', import.meta.url), 'utf8'));
const base = `http://127.0.0.1:${readConfig().port}`;
const selectedModel = process.env.LINEAR_TEST_MODEL ?? 'linear-agent';
const selectedEffort = process.env.LINEAR_TEST_EFFORT ?? 'auto';
async function read(path) {
  const response = await fetch(base + path, { headers: { authorization: 'Bearer ' + api_key }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
}
const admin = await openAdminSession(base);
let accounts, routing;
try {
  [accounts, routing] = await Promise.all(['/v1/accounts', '/v1/routing'].map(async route => {
    const response = await admin.request(route); assert.equal(response.status, 200); return response.json();
  }));
} finally { await admin.close(); }
const models = await read('/v1/models');
const knownAccounts = new Set(accounts.data.map(a => a.id));
async function request(body) {
  if (selectedEffort !== 'auto') body.reasoning_effort = selectedEffort;
  if(process.env.LINEAR_ACCOUNT_ID)body.account_id=process.env.LINEAR_ACCOUNT_ID;
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + api_key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(190000) });
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}: ${await response.text()}`);
  assert.equal(response.headers.get('x-linear-requested-reasoning-effort'), selectedEffort);
  return response;
}
const tests = [];
const firstResponse = await request({ model: selectedModel, messages: [{ role: 'user', content: '请记住本次测试的校验码是 LZ-7419。现在只回复 LINEAR_GATEWAY_OK。' }] });
const first = await firstResponse.json();
assert.equal(first.choices[0].message.content.trim(), 'LINEAR_GATEWAY_OK');
assert.match(first.account_id,/^acct-[a-f0-9]{20}$/);
assert.equal(first.requested_reasoning_effort, selectedEffort === 'auto' ? null : selectedEffort);
assert.equal(first.reasoning_effort_verified, false);
assert.equal(firstResponse.headers.get('x-linear-account-id'), first.account_id);
assert.equal(first.routing.strategy, process.env.LINEAR_ACCOUNT_ID ? 'explicit' : routing.policy.strategy);
assert.equal(Number(firstResponse.headers.get('x-linear-attempts')), first.routing.attempt_count);
assert(knownAccounts.has(first.account_id));
tests.push({ test: 'new_chat', result: first.choices[0].message.content, conversation_id: first.conversation_id, account_id:first.account_id, routing:first.routing });
console.log(JSON.stringify(tests.at(-1)));
const second = await (await request({ model: selectedModel, conversation_id: first.conversation_id, messages: [{ role: 'user', content: '我上一条消息里给你的校验码是什么？请只回复该校验码。' }] })).json();
assert.equal(second.choices[0].message.content.trim(), 'LZ-7419');
assert.equal(second.conversation_id, first.conversation_id);
assert.equal(second.account_id, first.account_id);
assert.equal(second.requested_reasoning_effort, first.requested_reasoning_effort);
assert.equal(second.routing.strategy, 'conversation');
assert.equal(second.routing.attempt_count, 1);
tests.push({ test: 'native_continuation', result: second.choices[0].message.content, conversation_id: second.conversation_id, account_id:second.account_id, routing:second.routing });
console.log(JSON.stringify(tests.at(-1)));
const sseResponse = await request({ model: selectedModel, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: '请只回复 LINEAR_SSE_OK。' }] });
const sse = await sseResponse.text();
const events = sse.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
assert.equal(events.at(-1), '[DONE]');
const chunks = events.slice(0, -1).map(JSON.parse);
assert(!chunks.some(c => c.error), 'SSE returned an upstream error');
const text = chunks.flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? '').join('');
assert.equal(text.trim(), 'LINEAR_SSE_OK');
assert(chunks.some(c => c.choices?.some(choice => choice.finish_reason === 'stop')));
const sseAccount = sseResponse.headers.get('x-linear-account-id');
assert(knownAccounts.has(sseAccount));
if (process.env.LINEAR_ACCOUNT_ID) assert.equal(sseAccount, first.account_id);
assert(chunks.every(c=>c.account_id===sseAccount));
assert(chunks.every(c=>c.requested_reasoning_effort === first.requested_reasoning_effort));
assert(chunks.every(c=>c.routing.strategy === first.routing.strategy && c.routing.attempt_count === Number(sseResponse.headers.get('x-linear-attempts'))));
tests.push({ test: 'buffered_sse', result: text, done: true, conversation_id: sseResponse.headers.get('x-linear-conversation-id'), account_id:sseAccount, routing:chunks[0].routing });
console.log(JSON.stringify(tests.at(-1)));
await fs.writeFile(new URL('../.local-runtime/live-validation.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), requested_model: selectedModel, requested_reasoning_effort: selectedEffort, reasoning_effort_verified: false, actual_model_identity_verified: false, tests }, null, 2));
const routingValidation = { checked_at: new Date().toISOString(), account_count: accounts.data.length, ready_account_count: routing.accounts.filter(a => a.status === 'ready').length, model_count: models.data.length, policy: routing.policy, real_multi_account_rotation_observed: first.account_id !== sseAccount, tests };
await fs.writeFile(new URL('../.local-runtime/routing-live-validation.json', import.meta.url), JSON.stringify(routingValidation, null, 2));
console.log(JSON.stringify({ account_count: routingValidation.account_count, ready_account_count: routingValidation.ready_account_count, model_count: routingValidation.model_count, policy: routingValidation.policy, real_multi_account_rotation_observed: routingValidation.real_multi_account_rotation_observed, passed: tests.length }));

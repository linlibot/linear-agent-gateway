import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AccountStore } from '../accounts.mjs';
import { ENDPOINT, SEND_QUERY, READ_QUERY, LinearClient, normalizeSession } from '../upstream.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const accounts = new AccountStore(runtime);
const account = await accounts.resolve({ accountId: process.env.LINEAR_ACCOUNT_ID });
const session = normalizeSession(account.session);
const client = new LinearClient(session);
const prompt = '你好';
const negativeModel = 'linear-probe/nonexistent-model';
const input = { conversationId: randomUUID(), userMessageId: randomUUID(), context: [], bodyData: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }] }, resume: true, model: negativeModel };
const response = await fetch(ENDPOINT, { method: 'POST', headers: session.headers, body: JSON.stringify({ query: SEND_QUERY, variables: { input } }), signal: AbortSignal.timeout(30000) });
const validation = await response.json();
if (validation.data?.aiConversationSendMessage?.success) {
  const id = validation.data.aiConversationSendMessage.aiConversation.id;
  await accounts.pin(id, account.id);
  await client.call('mutation AiConversationCancel($id:String!){aiConversationCancel(id:$id){success}}', { id }, AbortSignal.timeout(5000));
  throw new Error('The nonexistent model was unexpectedly accepted; no authoritative enum discovered.');
}
const constraint = validation.errors?.flatMap(e => e.extensions?.validationErrors ?? []).find(e => e.property === 'model')?.constraints?.isEnum;
if (!response.ok || !validation.errors?.some(e => e.extensions?.code === 'INVALID_INPUT') || !constraint?.startsWith('model must be one of the following values: ')) throw new Error('No model enum was returned; check account authentication before probing.');
await fs.writeFile(new URL('other-model-discovery-validation.json', runtime), JSON.stringify({ checkedAt: new Date().toISOString(), account_id: account.id, requested_model: negativeModel, http_status: response.status, accepted: false, errors: validation.errors }, null, 2));
const allModels = constraint.slice('model must be one of the following values: '.length).split(', function ')[0].split(', ').filter(v => /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9./:_-]*$/.test(v));
const families = { kimi: allModels.filter(m => /(?:^|[\/._-])kimi(?:[\/._-]|$)/i.test(m)), gemini: allModels.filter(m => /(?:^|[\/._-])gemini(?:[\/._-]|$)/i.test(m)), grok: allModels.filter(m => /grok|(?:^|\/)x-?ai\//i.test(m)) };
const previous = process.argv.includes('--retry-failed') ? JSON.parse(await fs.readFile(new URL('other-model-discovery.json', runtime), 'utf8')) : null;
if (previous && previous.account_id !== account.id) throw new Error('Retry account differs from the original probe.');
const report = previous ?? { checkedAt: new Date().toISOString(), account_id: account.id, actual_model_identity_verified: false, prompt,
  discovery_source: 'Fresh model enum returned by AiConversationSendMessage validation after rejecting a nonexistent-model negative control; no schema introspection.',
  negative_control: { requested_model: negativeModel, accepted: false, error_code: 'INVALID_INPUT' }, enumerated_model_ids: allModels, family_model_ids: families,
  isolation: { new_conversation_per_request: true, explicit_context: [], previous_messages_or_files_sent: false, reasoning_effort_omitted: true }, tests: [] };
report.latest_enum_checkedAt = new Date().toISOString();
report.enumerated_model_ids = allModels;
report.family_model_ids = families;
const latestTests = new Map(report.tests.map(t => [t.requested_model, t]));
const selectedModels = previous ? [...latestTests.values()].filter(t => !t.reply_received && allModels.includes(t.requested_model)).map(t => t.requested_model) : Object.values(families).flat();
const testedNow = [];
const file = new URL('other-model-discovery.json', runtime);
const outputFile = new URL('../outputs/other-model-discovery.json', import.meta.url);
await fs.mkdir(new URL('../outputs/', import.meta.url), { recursive: true });
const persist = async () => { const text = JSON.stringify(report, null, 2); await fs.writeFile(file, text); await fs.writeFile(outputFile, text); };
await persist();
console.log(JSON.stringify({ phase: 'begin', enum_models: allModels.length, family_model_ids: families, selected_models: selectedModels, prompt }));
for (const model of selectedModels) {
  const result = { requested_model: model, in_upstream_model_enum: true, requested_reasoning_effort: null, request_accepted: false, reply_received: false, actual_model_identity_verified: false };
  const started = performance.now();
  try {
    const reply = await client.chat({ text: prompt, requestedModel: model }, AbortSignal.timeout(180000), async id => {
      result.request_accepted = true; result.conversation_id = id;
      await accounts.pin(id, account.id);
    });
    result.reply_text = reply.text;
    result.reply_received = Boolean(reply.text.trim());
    result.reply_status = 'complete';
  } catch (error) { result.error_code = error.code ?? error.name; result.error = error.message; }
  result.duration_ms = Math.round(performance.now() - started);
  if (result.conversation_id) {
    try {
      const { aiConversation } = await client.call(READ_QUERY, { id: result.conversation_id }, AbortSignal.timeout(15000));
      result.native_status = aiConversation.status;
      result.native_error_messages = aiConversation.parts.filter(p => p.type === 'error').map(p => p.message);
      result.native_part_type_counts = Object.fromEntries([...new Set(aiConversation.parts.map(p => p.type))].map(type => [type, aiConversation.parts.filter(p => p.type === type).length]));
      result.native_tool_calls = aiConversation.parts.filter(p => p.type === 'toolCall').length;
    } catch { result.native_audit_unavailable = true; }
  }
  report.tests.push(result); testedNow.push(result); await persist();
  console.log(JSON.stringify(result));
  if (['linear_session_expired', 'linear_rate_limit'].includes(result.error_code)) { report.stopped_for = result.error_code; break; }
}
report.finishedAt = new Date().toISOString(); await persist();
const catalogFile = accounts.modelReportPath(account.id);
const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
if (catalog.account_id !== account.id) throw new Error('Model evidence account mismatch.');
catalog.tests.push(...testedNow);
catalog.checkedAt = report.finishedAt;
catalog.latest_other_model_discovery = { checkedAt: report.finishedAt, negative_control_rejected: true, family_model_ids: families };
await fs.writeFile(catalogFile, JSON.stringify(catalog, null, 2));
console.log(JSON.stringify({ phase: 'complete', tested: report.tests.length, passed: report.tests.filter(t => t.reply_received).length, missing_families: Object.entries(families).filter(([,models]) => !models.length).map(([family]) => family) }));

import fs from 'node:fs/promises';
import { AccountStore } from '../accounts.mjs';
import { LinearClient, normalizeSession, READ_QUERY } from '../upstream.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const accounts = new AccountStore(runtime);
const account = await accounts.resolve({ accountId: process.env.LINEAR_ACCOUNT_ID });
const validation = JSON.parse(await fs.readFile(new URL('claude-discovery-validation.json', runtime), 'utf8'));
if (validation.account_id !== account.id || validation.accepted !== false) throw new Error('A rejected negative control for this account is required.');
const constraint = validation.errors.flatMap(e => e.extensions?.validationErrors ?? []).find(e => e.property === 'model')?.constraints?.isEnum;
if (!constraint?.startsWith('model must be one of the following values: ')) throw new Error('No explicit model enumeration was returned.');
const allModels = constraint.slice('model must be one of the following values: '.length).split(', function ')[0].split(', ').filter(v => /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9./:_-]*$/.test(v));
const anthropicModels = allModels.filter(v => v.startsWith('anthropic/claude-'));
const previous = process.argv.includes('--retry-failed') ? JSON.parse(await fs.readFile(new URL('claude-model-discovery.json', runtime), 'utf8')) : null;
if (previous && previous.account_id !== account.id) throw new Error('Retry account differs from the original test.');
const models = previous ? [...new Set(previous.tests.filter(t => !t.reply_received).map(t => t.requested_model))] : ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-fable-5', 'anthropic/claude-fable-5-1', 'anthropic/claude-opus-5-5'];
const report = previous ?? {
  checkedAt: new Date().toISOString(), account_id: account.id, actual_model_identity_verified: false,
  discovery_source: 'AiConversationSendMessage model enum validation from a rejected nonexistent-model negative control; no schema introspection.',
  negative_control: { requested_model: validation.requested_model, accepted: false, error_code: 'INVALID_INPUT' },
  enumerated_model_ids: allModels, enumerated_anthropic_model_ids: anthropicModels,
  isolation: { new_conversation_per_request: true, explicit_context: [], previous_messages_or_files_sent: false },
  prompt: '请只回复 MODEL_OK。不要调用工具或启动 coding session。', tests: []
};
const file = new URL('claude-model-discovery.json', runtime);
await fs.writeFile(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ phase: 'begin', enum_models: allModels.length, enum_anthropic_models: anthropicModels, planned: models }));
const client = new LinearClient(normalizeSession(account.session));
const testedNow = [];
for (const model of models) {
  const started = performance.now();
  const result = { requested_model: model, in_upstream_model_enum: allModels.includes(model), request_accepted: false, reply_received: false, actual_model_identity_verified: false };
  try {
    if (!result.in_upstream_model_enum) throw new Error('This exact identifier is absent from the returned enum.');
    const response = await client.chat({ text: report.prompt, requestedModel: model }, AbortSignal.timeout(75000), async id => {
      result.request_accepted = true; result.conversation_id = id;
      await accounts.pin(id, account.id);
    });
    result.reply_text = response.text;
    result.reply_received = response.text.trim() === 'MODEL_OK';
    result.reply_status = 'complete';
    const { aiConversation } = await client.call(READ_QUERY, { id: response.conversationId }, AbortSignal.timeout(15000));
    result.native_part_type_counts = Object.fromEntries([...new Set(aiConversation.parts.map(p => p.type))].map(type => [type, aiConversation.parts.filter(p => p.type === type).length]));
    result.native_tool_calls = aiConversation.parts.filter(p => p.type === 'toolCall').length;
  } catch (error) {
    result.error_code = error.code ?? error.name; result.error = error.message;
    if (result.conversation_id) {
      try {
        const { aiConversation } = await client.call(READ_QUERY, { id: result.conversation_id }, AbortSignal.timeout(15000));
        result.reply_status = aiConversation.status;
        result.native_error_messages = aiConversation.parts.filter(p => p.type === 'error').map(p => p.message);
        result.native_part_type_counts = Object.fromEntries([...new Set(aiConversation.parts.map(p => p.type))].map(type => [type, aiConversation.parts.filter(p => p.type === type).length]));
      } catch { result.error_detail_unavailable = true; }
    }
  }
  result.duration_ms = Math.round(performance.now() - started);
  report.tests.push(result);
  testedNow.push(result);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(result));
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(file, JSON.stringify(report, null, 2));
const catalogPath = accounts.modelReportPath(account.id);
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
if (catalog.account_id !== account.id) throw new Error('Model evidence account mismatch.');
catalog.tests.push(...testedNow);
catalog.checkedAt = report.finishedAt;
catalog.latest_claude_discovery = { checkedAt: report.finishedAt, negative_control_rejected: true, enumerated_anthropic_model_ids: anthropicModels };
await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
await fs.mkdir(new URL('../outputs/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../outputs/claude-model-discovery.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ phase: 'complete', tested: report.tests.length, passed: report.tests.filter(t => t.reply_received).length }));

import fs from 'node:fs/promises';
import path from 'node:path';
import { AccountStore } from '../accounts.mjs';
import { LinearClient, normalizeSession, READ_QUERY, SEND_QUERY } from '../upstream.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const accounts = new AccountStore(runtime);
const account = await accounts.resolve({ accountId: process.env.LINEAR_ACCOUNT_ID });
const directory = await fs.mkdtemp(new URL('../outputs/claude-hello-', import.meta.url));
const prompt = '你好';
const cases = [
  { name: 'fable-5', model: 'anthropic/claude-fable-5' },
  { name: 'fable-5-1', model: 'anthropic/claude-fable-5-1' },
  { name: 'opus-5-5-high', model: 'anthropic/claude-opus-5-5', effort: 'high' },
];
const report = {
  startedAt: new Date().toISOString(), account_id: account.id, prompt,
  actual_model_identity_verified: false, actual_reasoning_budget_verified: false,
  isolation: { new_conversation_per_request: true, explicit_context: [], history_or_attachments_sent: false, separate_local_directory_per_case: true, same_linear_workspace: true },
  tests: []
};
await fs.writeFile(new URL('claude-hello-directory.txt', runtime), directory);
const persist = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
await persist();
console.log(JSON.stringify({ phase: 'begin', directory, prompt, cases }));
for (const testCase of cases) {
  const caseDirectory = path.join(directory, testCase.name);
  await fs.mkdir(caseDirectory);
  await fs.writeFile(path.join(caseDirectory, 'prompt.txt'), prompt);
  const result = { name: testCase.name, requested_model: testCase.model, requested_reasoning_effort: testCase.effort ?? null, request_accepted: false, reply_received: false, actual_model_identity_verified: false, reasoning_effort_verified: false };
  const client = new LinearClient(normalizeSession(account.session), { fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.query === SEND_QUERY) {
      const input = request.variables.input;
      const text = input.bodyData.content?.[0]?.content?.[0]?.text;
      if (text !== prompt || input.context.length !== 0 || input.model !== testCase.model || input.reasoningEffort !== testCase.effort) throw new Error('Outgoing request did not match the exact greeting test.');
      result.sent_input = input;
    }
    return fetch(url, options);
  } });
  const started = performance.now();
  try {
    const response = await client.chat({ text: prompt, requestedModel: testCase.model, ...(testCase.effort ? { reasoningEffort: testCase.effort } : {}) }, AbortSignal.timeout(200000), async id => {
      result.request_accepted = true; result.conversation_id = id;
      await accounts.pin(id, account.id);
    });
    result.reply_text = response.text;
    result.reply_received = Boolean(response.text.trim());
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
  report.tests.push(result);
  await fs.writeFile(path.join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2));
  await persist();
  console.log(JSON.stringify(result));
}
report.finishedAt = new Date().toISOString();
await persist();
await fs.writeFile(new URL('claude-hello-report.json', runtime), JSON.stringify(report, null, 2));
const catalogFile = accounts.modelReportPath(account.id);
const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
if (catalog.account_id !== account.id) throw new Error('Model evidence account mismatch.');
catalog.tests.push(...report.tests);
catalog.checkedAt = report.finishedAt;
await fs.writeFile(catalogFile, JSON.stringify(catalog, null, 2));
console.log(JSON.stringify({ phase: 'complete', directory, passed: report.tests.filter(t => t.reply_received).length, tested: report.tests.length }));

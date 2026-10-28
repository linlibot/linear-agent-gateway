// Probes what the real Linear client API offers for client tools and streaming.
//
// Default (free): GraphQL validation-only requests. Each probe makes variable coercion fail
// on purpose, so Linear rejects it before execution and no message is ever sent.
//   node scripts/probe-upstream-tools.mjs
// With --send (costs a few Linear Agent replies, each in a new conversation):
//   node scripts/probe-upstream-tools.mjs --send [--size 20000,60000]
// LINEAR_ACCOUNT_ID selects the account; LINEAR_TEST_MODEL the model parameter.
// The report (no cookies, no credentials) is written to outputs/upstream-tool-probe.json.

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountStore } from '../accounts.mjs';
import { ENDPOINT, LinearClient, MODEL, READ_QUERY_EXTENDED, SEND_QUERY, answerParts, answerText, currentTurnParts, linearToolCalls, normalizeSession } from '../upstream.mjs';
import { DocBuilder } from '../rich-doc.mjs';
import { normalizeMessages } from '../messages.mjs';
import { initialDocument, continuationDocument } from '../prompt-builder.mjs';
import { newNonce, normalizeToolChoice, normalizeTools, parseToolReply } from '../tool-protocol.mjs';

const runtime = new URL('../.local-runtime/', import.meta.url);
const output = new URL('../outputs/', import.meta.url);
const send = process.argv.includes('--send');
const sizeArgument = process.argv.includes('--size') ? process.argv[process.argv.indexOf('--size') + 1] : '';
const model = process.env.LINEAR_TEST_MODEL ?? MODEL;
const account = await new AccountStore(runtime).resolve({ accountId: process.env.LINEAR_ACCOUNT_ID });
const session = normalizeSession(account.session);
const client = new LinearClient(session, { pollMs: Number(process.env.LINEAR_PROBE_POLL_MS ?? 750) });
const report = { started_at: new Date().toISOString(), account_id: account.id, model_parameter: model, sends_enabled: send, validation: {}, live: {} };
const conversations = [];

const clip = text => String(text ?? '').replace(/\s+/g, ' ').slice(0, 400);
/** Raw GraphQL call returning only error messages and codes (never headers or cookies). */
async function raw(query, variables) {
  const response = await fetch(ENDPOINT, { method: 'POST', headers: session.headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, data: body?.data ?? null, errors: (body?.errors ?? []).map(e => ({ message: String(e.message ?? ''), code: e.extensions?.code ?? null })) };
}
async function persist() {
  report.updated_at = new Date().toISOString();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(new URL('upstream-tool-probe.json', output), JSON.stringify(report, null, 2));
}

// 1. Read-side fields used by the gateway (body, endedAt, tool call names).
{
  const result = await raw(READ_QUERY_EXTENDED, { id: randomUUID() });
  report.validation.detailed_read = { accepted: !result.errors.some(e => e.code === 'GRAPHQL_VALIDATION_FAILED' || /Cannot query field|Unknown type/.test(e.message)), errors: result.errors };
}
// 2. Does AiConversationSendMessageInput accept any tool-related field? `resume` and
//    `conversationId` get invalid values, so the request can never execute.
{
  const candidates = ['tools', 'clientTools', 'toolDefinitions', 'functions', 'toolChoice', 'toolResults', 'toolResult', 'functionResults', 'systemPrompt', 'instructions', 'mcpServers', 'stream'];
  const input = { conversationId: { invalid: true }, userMessageId: randomUUID(), context: [], bodyData: { type: 'doc', content: [] }, resume: 'NOT_A_BOOLEAN' };
  for (const name of candidates) input[name] = [];
  const result = await raw(SEND_QUERY, { input });
  const undefinedField = name => result.errors.some(e => new RegExp(`Field "${name}" is not defined by type`).test(e.message));
  report.validation.send_input_fields = {
    executed: Boolean(result.data?.aiConversationSendMessage),
    unknown: candidates.filter(undefinedField),
    not_reported_as_unknown: candidates.filter(name => !undefinedField(name)),
    suggestions: [...new Set(result.errors.flatMap(e => [...e.message.matchAll(/Did you mean ([^?]+)\?/g)].map(m => m[1])))],
    errors: result.errors.slice(0, 20).map(e => ({ ...e, message: e.message.includes('is not defined by type') ? e.message.slice(e.message.indexOf(';') + 1).trim() : clip(e.message) })),
  };
}
// 3. Is there any mutation for submitting tool results? Unknown fields are validation errors;
//    GraphQL servers that keep suggestions enabled list similar real mutation names.
{
  const names = ['aiConversationSubmitToolResult', 'aiConversationToolResult', 'aiConversationAddToolResult', 'aiConversationRespondToElicitation', 'aiConversationClientTool', 'aiConversationResume'];
  report.validation.tool_result_mutations = [];
  for (const name of names) {
    // An absent required variable prevents execution even if a guessed field exists.
    const result = await raw(`mutation Probe($block: Boolean!) { ${name} @include(if: $block) }`, {});
    report.validation.tool_result_mutations.push({ name, exists: !result.errors.some(e => /Cannot query field/.test(e.message)), errors: result.errors });
  }
}
// 4. Subscription availability over HTTP (Linear's own client streams via its sync engine).
{
  const result = await raw('subscription Probe { aiConversationUpdated { id status } }', {});
  report.validation.subscription_over_http = { errors: result.errors, data: Boolean(result.data) };
}
await persist();
console.log(JSON.stringify({ phase: 'validation', ...report.validation }, null, 2));

async function startTurn(doc, conversationId) {
  const sent = await client.call(SEND_QUERY, { input: { conversationId: conversationId ?? randomUUID(), userMessageId: randomUUID(), context: [], bodyData: doc, resume: true, ...(model === MODEL ? {} : { model }) } }, AbortSignal.timeout(30000));
  const accepted = sent.aiConversationSendMessage;
  if (!conversations.includes(accepted.aiConversation.id)) conversations.push(accepted.aiConversation.id);
  return { conversationId: accepted.aiConversation.id, turnId: accepted.assistantMessage.id };
}
/** Polls one turn and records how its visible answer grows. */
async function observe({ conversationId, turnId }, { pollMs = 500, timeoutMs = 240000 } = {}) {
  const started = Date.now(), samples = [];
  let finishedPolls = 0;
  for (;;) {
    const conversation = await client.read(conversationId, AbortSignal.timeout(20000));
    const parts = currentTurnParts(conversation, turnId);
    const text = answerText(parts);
    samples.push({ ms: Date.now() - started, status: conversation.status, answer_parts: answerParts(parts).length, chars: text.length, ended: answerParts(parts).map(p => Boolean(p.metadata?.endedAt)), part_types: [...new Set(parts.map(p => p.type))] });
    if (conversation.status !== 'active' && conversation.status !== 'pending' && (text || ++finishedPolls >= 3)) return { text, markdown: answerParts(parts).map(p => p.body ?? '').join('\n\n'), parts, samples, status: conversation.status, linear_tools: linearToolCalls(parts) };
    if (Date.now() - started > timeoutMs) throw new Error('probe turn timed out');
    await sleep(pollMs);
  }
}

const tools = normalizeTools([
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file in the user\'s local project.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the user\'s local project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
]);
const auto = normalizeToolChoice('auto', tools);

if (send) {
  try {
    // a. Does the visible answer grow while the turn is active (incremental streaming via polling)?
    const stream = await observe(await startTurn(new DocBuilder().paragraph('Write eight numbered paragraphs of about 60 words each about the history of bicycles. Do not use any tools.').build()), { pollMs: Number(process.env.LINEAR_PROBE_POLL_MS ?? 500) });
    const finalChars = stream.text.length;
    report.live.streaming = { final_chars: finalChars, polls: stream.samples.length, incremental_text_observed: stream.samples.some(s => s.status === 'active' && s.chars > 0 && s.chars < finalChars), samples: stream.samples };
    await persist();
    // b. Are code blocks and line breaks delivered to the model verbatim?
    const tricky = 'const a = `x`; // *not* _markdown_ [link](y)\n  # not a heading\n- not a list\n```inner fence```\n\ttab and trailing spaces   ';
    const echo = await observe(await startTurn(new DocBuilder().paragraph('Copy the content of the code block below exactly, character for character, into a single fenced code block with the info string echo. Output nothing else and do not use any tools.').code(tricky).build()));
    const echoed = (echo.text.match(/```+echo\n([\s\S]*?)\n```+\s*$/) ?? [])[1] ?? null;
    report.live.code_block_fidelity = { exact: echoed === tricky, trimmed_equal: echoed?.trimEnd() === tricky.trimEnd(), reply: clip(echo.text) };
    await persist();
    // c. Structured tool protocol over two turns in one conversation.
    const messages = normalizeMessages([{ role: 'system', content: 'You are a coding assistant. Use the client tools to change files.' }, { role: 'user', content: 'Create index.html with a page titled "Probe" and a heading "Hello".' }]).messages;
    let nonce = newNonce();
    const first = await observe(await startTurn(initialDocument({ messages, tools, choice: auto, parallel: true, nonce, format: 'rich', names: new Map() }).build()));
    const parsedFirst = parseToolReply([first.text, first.markdown], { tools, choice: auto, parallel: true, nonce });
    report.live.tool_protocol = { first_turn: { valid_tool_calls: parsedFirst.toolCalls.map(c => ({ name: c.name, argument_keys: Object.keys(c.arguments) })), problems: parsedFirst.problems, content: clip(parsedFirst.content), linear_internal_tools: first.linear_tools, part_types: [...new Set(first.parts.map(p => p.type))] } };
    if (parsedFirst.toolCalls.length) {
      nonce = newNonce();
      // This probe never executes client tools. Report the actual denial instead of
      // inventing a successful write; use local-coding-client for real file changes.
      const delta = normalizeMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_probe1', type: 'function', function: { name: parsedFirst.toolCalls[0].name, arguments: parsedFirst.toolCalls[0].argumentsJson } }] }, { role: 'tool', tool_call_id: 'call_probe1', content: 'Denied by this probe. No local tool was executed and no file was created.' }, { role: 'user', content: 'The write was denied. Try requesting write_file again with the same path.' }]).messages.slice(2);
      const conversationId = conversations.at(-1);
      const second = await observe(await startTurn(continuationDocument({ delta, tools, choice: auto, parallel: true, nonce, format: 'rich', names: new Map([['call_probe1', parsedFirst.toolCalls[0].name]]), includeProtocol: false, toolsChanged: false }).build(), conversationId));
      const parsedSecond = parseToolReply([second.text, second.markdown], { tools, choice: auto, parallel: true, nonce });
      report.live.tool_protocol.second_turn = { valid_tool_calls: parsedSecond.toolCalls.map(c => ({ name: c.name, arguments: c.arguments })), problems: parsedSecond.problems, content: clip(parsedSecond.content), linear_internal_tools: second.linear_tools };
    }
    await persist();
    // d. Optional message size limits.
    for (const size of sizeArgument.split(',').map(Number).filter(n => n > 0)) {
      try {
        const doc = new DocBuilder().paragraph('Reply with only the word OK. Do not use tools.').code('x'.repeat(size)).build();
        const result = await observe(await startTurn(doc), { timeoutMs: 180000 });
        (report.live.size_limits ??= []).push({ chars: size, accepted: true, reply: clip(result.text) });
      } catch (error) { (report.live.size_limits ??= []).push({ chars: size, accepted: false, error: error.code ?? error.message }); }
      await persist();
    }
  } finally {
    for (const id of conversations) await client.cancel(id);
    report.conversations_created = conversations.length;
    await persist();
  }
  console.log(JSON.stringify({ phase: 'live', streaming: { incremental_text_observed: report.live.streaming?.incremental_text_observed, polls: report.live.streaming?.polls }, code_block_fidelity: report.live.code_block_fidelity, tool_protocol: report.live.tool_protocol, size_limits: report.live.size_limits }, null, 2));
}
console.log('Report: outputs/upstream-tool-probe.json');

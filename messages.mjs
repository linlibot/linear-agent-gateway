// OpenAI Chat Completions message validation, canonical hashing and transcript
// helpers. Message contents are never logged or persisted; only hashes are.

import { createHash } from 'node:crypto';
import { GatewayError } from './errors.mjs';
import { stableStringify } from './json-schema.mjs';

export const MAX_MESSAGES = 4096;
const ROLES = ['system', 'developer', 'user', 'assistant', 'tool'];
const TOOL_CALL_ID = /^[\x21-\x7e]{1,256}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => new GatewayError(400, code, message);

function contentText(content, label, { allowNull = false } = {}) {
  if (content === undefined || content === null) {
    if (allowNull) return null;
    throw fail('unsupported_content', `Only text content is supported: ${label}.content is missing.`);
  }
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part, index) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      if (['image_url', 'input_image', 'input_audio', 'file', 'input_file'].includes(part?.type)) throw fail('unsupported_content', `Only text content is supported: ${label}.content[${index}] is ${part.type}.`);
      throw fail('unsupported_content', `Only text content is supported: ${label}.content[${index}] must be a text part.`);
    }).join('\n');
  }
  throw fail('unsupported_content', `Only text content is supported: ${label}.content must be a string or text parts.`);
}

function normalizeToolCalls(calls, label, seen) {
  if (!Array.isArray(calls) || !calls.length) throw fail('invalid_tool_messages', `${label}.tool_calls must be a non-empty array.`);
  return calls.map((call, index) => {
    const where = `${label}.tool_calls[${index}]`;
    if (!isObject(call) || (call.type !== undefined && call.type !== 'function') || !isObject(call.function)) throw fail('invalid_tool_messages', `${where} must be a function tool call.`);
    if (typeof call.id !== 'string' || !TOOL_CALL_ID.test(call.id)) throw fail('invalid_tool_messages', `${where}.id must be a non-empty string.`);
    if (seen.has(call.id)) throw fail('invalid_tool_messages', `Duplicate tool_call id ${call.id}.`);
    seen.add(call.id);
    if (typeof call.function.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.function.name)) throw fail('invalid_tool_messages', `${where}.function.name is not a valid function name.`);
    const args = call.function.arguments;
    const text = typeof args === 'string' ? args : args === undefined || args === null ? '{}' : JSON.stringify(args);
    try { if (!isObject(JSON.parse(text))) throw new Error(); }
    catch { throw fail('invalid_tool_messages', `${where}.function.arguments must encode a JSON object.`); }
    return { id: call.id, name: call.function.name, arguments: text };
  });
}

/**
 * Validates messages using the OpenAI rules for tool loops and returns
 * { messages, hasToolHistory }. With allowTools false, tool history is rejected
 * exactly like the original text-only gateway.
 */
export function normalizeMessages(messages, { allowTools = true } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw fail('invalid_messages', 'messages must be a non-empty array.');
  if (messages.length > MAX_MESSAGES) throw fail('invalid_messages', `messages may contain at most ${MAX_MESSAGES} entries.`);
  const seen = new Set();
  let pending = null; // { ids: Set, answered: Set, index } for the latest assistant tool_calls message
  let hasToolHistory = false;
  const normalized = messages.map((message, index) => {
    const label = `messages[${index}]`;
    if (!isObject(message) || !ROLES.includes(message.role)) throw fail('unsupported_message', `${label}.role must be system, developer, user, assistant or tool.`);
    if ((message.function_call !== undefined && message.function_call !== null) || message.role === 'function') throw fail('unsupported_message', `${label} uses legacy function_call; send tools/tool_calls instead.`);
    if (message.role !== 'assistant' && message.tool_calls != null) throw fail('invalid_tool_messages', `${label}: tool_calls is only valid on assistant messages.`);
    if (message.role !== 'tool' && message.tool_call_id != null) throw fail('invalid_tool_messages', `${label}: tool_call_id is only valid on tool messages.`);
    const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!allowTools && (message.role === 'tool' || message.tool_calls)) throw fail('unsupported_message', 'Only text system/developer/user/assistant messages are supported.');
    if (message.role !== 'tool' && pending && pending.answered.size < pending.ids.size) {
      const missing = [...pending.ids].filter(id => !pending.answered.has(id));
      throw fail('invalid_tool_messages', `An assistant message with tool_calls must be followed by tool messages responding to each tool_call_id. Missing: ${missing.join(', ')}.`);
    }
    if (message.role !== 'tool') pending = null;
    if (message.role === 'assistant') {
      const toolCalls = hasCalls ? normalizeToolCalls(message.tool_calls, label, seen) : [];
      if (message.tool_calls !== undefined && message.tool_calls !== null && !Array.isArray(message.tool_calls)) throw fail('invalid_tool_messages', `${label}.tool_calls must be an array.`);
      if (toolCalls.length) { hasToolHistory = true; pending = { ids: new Set(toolCalls.map(c => c.id)), answered: new Set(), names: new Map(toolCalls.map(c => [c.id, c.name])) }; }
      return { role: 'assistant', content: contentText(message.content, label, { allowNull: true }), toolCalls };
    }
    if (message.role === 'tool') {
      hasToolHistory = true;
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) throw fail('invalid_tool_messages', `${label}.tool_call_id is required.`);
      if (!pending || !pending.ids.has(message.tool_call_id)) throw fail('invalid_tool_messages', `${label}: messages with role "tool" must respond to a tool_call_id of the preceding assistant message.`);
      if (pending.answered.has(message.tool_call_id)) throw fail('invalid_tool_messages', `${label} repeats the result for ${message.tool_call_id}.`);
      pending.answered.add(message.tool_call_id);
      return { role: 'tool', toolCallId: message.tool_call_id, name: pending.names.get(message.tool_call_id), content: contentText(message.content ?? '', label) };
    }
    return { role: message.role, content: contentText(message.content, label) };
  });
  if (pending && pending.answered.size < pending.ids.size) {
    const missing = [...pending.ids].filter(id => !pending.answered.has(id));
    throw fail('invalid_tool_messages', `An assistant message with tool_calls must be followed by tool messages responding to each tool_call_id. Missing: ${missing.join(', ')}.`);
  }
  const last = normalized.at(-1);
  if (last.role === 'tool') return { messages: normalized, hasToolHistory };
  if (last.role !== 'user' || !last.content.trim()) throw fail('invalid_messages', allowTools ? 'The final message must be a user message with text or a tool result.' : 'The final message must contain user text.');
  return { messages: normalized, hasToolHistory };
}

const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
const words = text => String(text ?? '').replace(/\s+/g, ' ').trim();
function canonicalArguments(text) {
  try { return stableStringify(JSON.parse(text)); } catch { return String(text); }
}

/** Order-sensitive, whitespace-tolerant identity of a message for continuation matching. */
export function canonicalMessage(message) {
  if (message.role === 'assistant') return ['assistant', words(message.content), message.toolCalls.map(c => [c.id, c.name, canonicalArguments(c.arguments)])];
  if (message.role === 'tool') return ['tool', message.toolCallId, lines(message.content)];
  return [message.role, lines(message.content)];
}

const ROOT = createHash('sha256').update('linear-agent-gateway/messages/v1').digest('hex');
export const chainHash = (previous, message) => createHash('sha256').update(previous + '\n' + JSON.stringify(canonicalMessage(message))).digest('hex');

/** Hash after each message: hashes[i] identifies messages[0..i]. */
export function prefixHashes(messages, scope = 'legacy') {
  const hashes = [];
  let current = createHash('sha256').update(ROOT + ':' + scope).digest('hex');
  for (const message of messages) { current = chainHash(current, message); hashes.push(current); }
  return hashes;
}

/** Map from tool_call_id to function name for every assistant tool call. */
export function toolCallNames(messages) {
  return new Map(messages.flatMap(m => m.role === 'assistant' ? m.toolCalls.map(c => [c.id, c.name]) : []));
}

/** True when any assistant tool call in the history used a file-changing tool name. */
export function historyHasFileChanges(messages) {
  return messages.some(m => m.role === 'assistant' && m.toolCalls.some(c => FILE_CHANGE_TOOL.test(c.name)));
}

export const FILE_CHANGE_TOOL = /(write|edit|create|apply|patch|replace|insert|save|delete|remove|rename|move|mkdir|append|update_file|str_replace)/i;

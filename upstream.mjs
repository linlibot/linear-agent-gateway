import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { GatewayError } from './errors.mjs';
import { textDoc } from './rich-doc.mjs';
import { normalizeMessages } from './messages.mjs';
import { normalizeToolChoice, normalizeTools } from './tool-protocol.mjs';

export { GatewayError };
export const MODEL = 'linear-agent';
export const REASONING_EFFORTS = ['auto', 'low', 'medium', 'high'];
export const ENDPOINT = 'https://client-api.linear.app/graphql';
export const SEND_QUERY = `mutation AiConversationSendMessage($input: AiConversationSendMessageInput!) {
  aiConversationSendMessage(input: $input) {
    success lastSyncId aiConversation { id } userMessage { id } assistantMessage { id }
  }
}`;
export const READ_QUERY = `query LinearAgentRead($id: String!) {
  aiConversation(id: $id) {
    id status parts {
      __typename
      ... on AiConversationBasePart { id type metadata { phase turnId } }
      ... on AiConversationTextPart { bodyData }
      ... on AiConversationErrorPart { message }
    }
  }
}`;
// Fields below are taken from Linear's published GraphQL schema (AiConversationTextPart.body,
// AiConversationPartMetadata.startedAt/endedAt, AiConversationBaseToolCall.name). If the
// client API rejects them, the client falls back to READ_QUERY for the rest of the process.
export const READ_QUERY_EXTENDED = `query LinearAgentReadDetailed($id: String!) {
  aiConversation(id: $id) {
    id status parts {
      __typename
      ... on AiConversationBasePart { id type metadata { phase turnId startedAt endedAt } }
      ... on AiConversationTextPart { body bodyData }
      ... on AiConversationErrorPart { message }
      ... on AiConversationToolCallPart { toolCall { __typename ... on AiConversationBaseToolCall { name } } }
    }
  }
}`;
const CANCEL_QUERY = `mutation AiConversationCancel($id: String!) {
  aiConversationCancel(id: $id) { success aiConversation { id } }
}`;
const EMPTY_COMPLETE_POLLS = 3;
let detailedReadSupported = true;
export const detailedReadState = { get supported() { return detailedReadSupported; }, reset() { detailedReadSupported = true; } };

export async function loadSession(path) {
  let session;
  try { session = JSON.parse(await fs.readFile(path, 'utf8')); }
  catch { throw new GatewayError(503, 'linear_session_unavailable', 'Cannot read the local Linear session file.'); }
  return normalizeSession(session);
}

export function normalizeSession(session) {
  if (!session || typeof session !== 'object') throw new GatewayError(503, 'invalid_session', 'Invalid Linear session format.');
  if (session.endpoint !== ENDPOINT) throw new GatewayError(503, 'invalid_session', 'Unexpected Linear upstream endpoint.');
  const allowed = new Set(['cookie', 'content-type', 'user', 'useraccount', 'organization', 'origin', 'user-agent', 'linear-client-id', 'linear-client-version', 'linear-client-database-id']);
  const headers = Object.fromEntries(Object.entries(session.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]).filter(([k, v]) => allowed.has(k) && typeof v === 'string'));
  if (Object.values(headers).some(value => /[\r\n\0]/.test(value))) throw new GatewayError(503, 'invalid_session', 'Invalid Linear request headers.');
  if (!headers.cookie || !headers.organization || !headers.user) throw new GatewayError(503, 'invalid_session', 'The Linear session is missing authentication or workspace headers.');
  headers['content-type'] = 'application/json';
  headers.origin = 'https://linear.app';
  return { headers };
}

export function richText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(richText).join('');
  if (node.type === 'text') {
    let text = node.text ?? '';
    for (const mark of node.marks ?? []) {
      if (mark.type === 'code') text = '`' + text + '`';
      if (mark.type === 'strong' || mark.type === 'bold') text = '**' + text + '**';
      if (mark.type === 'em' || mark.type === 'italic') text = '*' + text + '*';
      if (mark.type === 'strike') text = '~~' + text + '~~';
      if (mark.type === 'link' && mark.attrs?.href) text = `[${text}](${mark.attrs.href})`;
    }
    return text;
  }
  const children = node.content ?? [];
  if (node.type === 'hard_break') return '\n';
  if (node.type === 'doc') return children.map(richText).join('\n\n');
  if (node.type === 'heading') return '#'.repeat(Math.max(1, Math.min(6, node.attrs?.level ?? 1))) + ' ' + richText(children);
  if (node.type === 'code_block') {
    const code = children.map(n => n.text ?? richText(n)).join('');
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `${fence}${node.attrs?.language ?? ''}\n${code}\n${fence}`;
  }
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    return children.map((n, i) => {
      const prefix = node.type === 'bullet_list' ? '- ' : `${(node.attrs?.order ?? 1) + i}. `;
      return prefix + richText(n).replace(/\n/g, '\n' + ' '.repeat(prefix.length));
    }).join('\n');
  }
  if (node.type === 'list_item') return children.map(richText).join('\n');
  if (node.type === 'blockquote') return children.map(richText).join('\n\n').split('\n').map(s => '> ' + s).join('\n');
  if (node.type === 'horizontal_rule') return '---';
  if (node.type === 'table') return children.map(richText).join('\n');
  if (node.type === 'table_row') return '| ' + children.map(richText).join(' | ') + ' |';
  if (children.length) return richText(children);
  return node.attrs?.label ?? node.attrs?.title ?? node.attrs?.text ?? '';
}

export function currentTurnParts(conversation, assistantId) {
  return (conversation.parts ?? []).filter(p => p.metadata?.turnId === assistantId || p.id === assistantId || p.id?.startsWith(assistantId + ':'));
}

export function htmlDocumentSource(doc) {
  // Bare HTML can be parsed by Linear as Markdown (e.g. CSS '* {' becomes a list).
  // Restore source formatting only for complete, unfenced HTML documents.
  if (doc?.type !== 'doc' || doc.content?.[0]?.type !== 'paragraph') return null;
  const beginning = richText(doc.content[0]).trimStart();
  if (!/^(?:<!doctype html\b|<html\b)/i.test(beginning)) return null;
  function source(node) {
    if (node.type === 'text' || node.type === 'hard_break') return richText(node);
    const children = node.content ?? [];
    if (node.type === 'code_block') return children.map(n => n.text ?? source(n)).join('');
    if (node.type === 'doc') return children.map(source).join('\n\n');
    if (node.type === 'paragraph') return children.map(source).join('');
    if (node.type === 'list_item') return children.map(source).join('\n\n');
    if (node.type === 'bullet_list' || node.type === 'ordered_list') return children.map((n, i) => {
      const prefix = node.type === 'bullet_list' ? '* ' : `${(node.attrs?.order ?? 1) + i}. `;
      return prefix + source(n).replace(/\n/g, '\n' + ' '.repeat(prefix.length));
    }).join('\n');
    return richText(node);
  }
  const html = source(doc).trim();
  return /<\/html>\s*$/i.test(html) ? html : null;
}

export function startsLikeHtmlDocument(doc) {
  return doc?.type === 'doc' && doc.content?.[0]?.type === 'paragraph' && /^(?:<!doctype html\b|<html\b)/i.test(richText(doc.content[0]).trimStart());
}

/** Visible answer parts of a turn: text parts outside the commentary phase. Reasoning is never included. */
export function answerParts(parts) {
  return parts.filter(p => p.type === 'text' && p.metadata?.phase === 'answer');
}

export function renderAnswerPart(p) {
  const html = htmlDocumentSource(p.bodyData);
  if (!html) return richText(p.bodyData);
  const fence = '`'.repeat(Math.max(3, ...[...html.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${fence}html\n${html}\n${fence}`;
}

export function answerText(parts) {
  return answerParts(parts).map(renderAnswerPart).filter(Boolean).join('\n\n');
}

/** Markdown bodies of the answer parts when the upstream provides them (detailed read). */
export function answerMarkdown(parts) {
  const answer = answerParts(parts);
  if (!answer.length || !answer.every(p => typeof p.body === 'string')) return null;
  return answer.map(p => p.body).filter(Boolean).join('\n\n');
}

/** Names of Linear's own built-in tool calls in a turn. Arguments and results are not exposed. */
export function linearToolCalls(parts) {
  return parts.filter(p => p.type === 'toolCall').map(p => p.toolCall?.name ?? 'unknown');
}

function legacyToolOptions(body) {
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) throw new GatewayError(400, 'invalid_tools', 'tools must be an array of at most 128 function definitions.');
  const tools = body.tools ?? [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) throw new GatewayError(400, 'invalid_tools', 'Only named function tool definitions are accepted for text-only compatibility.');
  }
  const choice = body.tool_choice ?? 'auto';
  if (choice !== 'auto' && choice !== 'none') {
    if (choice === 'required' || (choice && typeof choice === 'object' && !Array.isArray(choice) && choice.type === 'function' && typeof choice.function?.name === 'string')) throw new GatewayError(400, 'client_tools_unavailable', 'Required client tool calls are not supported while LINEAR_CLIENT_TOOLS=off. Use tool_choice auto/none for a text reply, or enable client tools on the gateway. Linear built-in tools are separate.');
    throw new GatewayError(400, 'invalid_tool_choice', 'tool_choice must be auto or none for text-only compatibility.');
  }
  if (!tools.length) return null;
  return { client_tools: 'unavailable', ignored_tool_definitions: tools.length, tool_choice: choice };
}

const CORE_PARAMETERS = new Set(['model', 'messages', 'stream', 'stream_options', 'conversation_id', 'account_id', 'tools', 'tool_choice', 'reasoning_effort', 'parallel_tool_calls']);
// Accepted for client compatibility but not forwarded: Linear's agent API has no sampling or
// length controls. They are reported back in `ignored_parameters`, never silently applied.
export const IGNORED_PARAMETERS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'seed', 'stop', 'user', 'metadata', 'store', 'logit_bias', 'n', 'logprobs', 'top_logprobs', 'service_tier', 'prompt_cache_key', 'safety_identifier', 'verbosity', 'modalities', 'response_format', 'prediction'];

function checkIgnored(body, strict) {
  const ignored = [];
  for (const key of Object.keys(body)) {
    if (CORE_PARAMETERS.has(key)) continue;
    if (!IGNORED_PARAMETERS.includes(key) || strict) throw new GatewayError(400, 'unsupported_parameter', `Parameter ${key} is not supported by Linear Agent chat.`);
    const value = body[key];
    if (value === null || value === undefined) continue;
    if (key === 'n' && value !== 1) throw new GatewayError(400, 'unsupported_parameter', 'Only n=1 is supported.');
    if (key === 'logprobs' && value !== false) throw new GatewayError(400, 'unsupported_parameter', 'logprobs are not available from Linear.');
    if (key === 'modalities' && !(Array.isArray(value) && value.every(v => v === 'text'))) throw new GatewayError(400, 'unsupported_parameter', 'Only text output is supported.');
    if (key === 'response_format' && value?.type !== 'text') throw new GatewayError(400, 'unsupported_parameter', 'Only response_format {"type":"text"} is supported; JSON modes are not available from Linear.');
    ignored.push(key);
  }
  return ignored;
}

export function validateRequest(body, allowedModels = [MODEL], { clientTools = 'structured', strictParameters = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError(400, 'invalid_request', 'Expected a JSON object.');
  const ignoredParameters = checkIgnored(body, strictParameters);
  if (typeof body.model !== 'string' || !allowedModels.includes(body.model)) throw new GatewayError(400, 'unsupported_model', 'Choose a model from /v1/models. Only the default entry and locally tested model parameters are enabled.');
  const effort = body.reasoning_effort ?? 'auto';
  if (!REASONING_EFFORTS.includes(effort)) throw new GatewayError(400, 'invalid_reasoning_effort', 'reasoning_effort must be auto, low, medium or high. Omit it or use auto to keep the Linear default.');
  if (body.account_id !== undefined && (typeof body.account_id !== 'string' || !/^acct-[a-f0-9]{20}$/.test(body.account_id))) throw new GatewayError(400, 'invalid_account', 'account_id must be an ID returned by /v1/accounts.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new GatewayError(400, 'invalid_request', 'stream must be a boolean.');
  if (body.stream_options !== undefined && body.stream_options !== null && (!body.stream || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage' && k !== 'include_obfuscation') || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) throw new GatewayError(400, 'invalid_request', 'stream_options supports only include_usage with stream=true. Token usage is unavailable.');
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null && typeof body.parallel_tool_calls !== 'boolean') throw new GatewayError(400, 'invalid_request', 'parallel_tool_calls must be a boolean.');
  if (body.conversation_id !== undefined && (typeof body.conversation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.conversation_id))) throw new GatewayError(400, 'invalid_conversation', 'conversation_id must be a UUID.');
  const common = { requestedModel: body.model, accountId: body.account_id, conversationId: body.conversation_id, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, ignoredParameters, ...(effort === 'auto' ? {} : { reasoningEffort: effort }) };
  const legacy = clientTools === 'off';
  const compatibility = legacy ? legacyToolOptions(body) : null;
  const tools = legacy ? [] : normalizeTools(body.tools);
  const choice = legacy ? null : normalizeToolChoice(body.tool_choice, tools);
  const { messages, hasToolHistory } = normalizeMessages(body.messages, { allowTools: !legacy });
  if (!legacy && (tools.length || hasToolHistory)) {
    if (body.conversation_id !== undefined) {
      const [first] = messages;
      const delta = (messages.length === 1 && first.role === 'user') || (first.role === 'assistant' && first.toolCalls.length && messages.slice(1).every(m => m.role === 'tool' || m.role === 'user'));
      if (!delta) throw new GatewayError(400, 'invalid_messages', 'When continuing conversation_id with tools, send only the new user message, or the assistant tool_calls message followed by its tool results.');
    }
    return { mode: 'tools', ...common, messages, tools, choice, parallelToolCalls: body.parallel_tool_calls !== false, hasToolHistory };
  }
  if (body.conversation_id !== undefined && messages.length !== 1) throw new GatewayError(400, 'invalid_messages', 'When continuing conversation_id, send only the new user message.');
  const history = messages.length === 1 ? messages[0].content : '以下是调用方提供的对话历史，请根据这些内容回复最后一条用户消息。\n\n' + messages.map(m => `[${m.role}]\n${m.content ?? ''}`).join('\n\n');
  const text = compatibility ? '本次客户端只接收最终文本回复；客户端提供的外部工具未连接，无法调用它们。对代码生成任务，请在回复中直接给出完整代码。\n\n' + history : history;
  return { mode: 'chat', text, ...common, ...(compatibility ? { compatibility } : {}) };
}

export class LinearClient {
  constructor(session, { fetchImpl = fetch, pollMs = 1500 } = {}) {
    this.session = session;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
  }
  async call(query, variables, signal) {
    let response;
    try {
      response = await this.fetch(ENDPOINT, { method: 'POST', headers: this.session.headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30000)]) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new GatewayError(502, 'linear_network_error', 'The request to Linear failed or timed out.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new GatewayError(502, 'linear_invalid_response', 'Linear returned a non-JSON response.'); }
    if (!response.ok || result.errors?.length) {
      if (result.data?.aiConversationSendMessage) throw new GatewayError(502, 'linear_send_uncertain', 'Linear returned an ambiguous send result. The request will not be replayed.');
      const auth = [401, 403].includes(response.status) || result.errors?.some(e => /AUTHENTICATION|UNAUTHENTICATED/.test(e.extensions?.code ?? ''));
      if (auth) throw new GatewayError(503, 'linear_session_expired', 'Linear authentication failed. Refresh the local login session.');
      if (response.status === 429) throw new GatewayError(429, 'linear_rate_limit', 'Linear rate limit reached. Please wait before trying again.');
      if (result.errors?.some(e => e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED' || /^(Cannot query field|Unknown type|Unknown fragment|Fragment cannot be spread)/.test(e.message ?? ''))) throw new GatewayError(502, 'linear_query_unsupported', 'Linear does not accept this query shape.');
      // Input validation errors mean the operation did not run; callers may adjust and resend.
      const invalidInput = Boolean(result.errors?.length && result.errors.every(e => e.extensions?.code === 'BAD_USER_INPUT' && !e.path && /^Variable "\$input" got invalid value/.test(e.message ?? '')));
      throw Object.assign(new GatewayError(502, 'linear_upstream_error', 'Linear rejected the chat request.'), { invalidInput });
    }
    if (!result.data) throw new GatewayError(502, 'linear_invalid_response', 'Linear returned no data.');
    return result.data;
  }
  async read(id, signal) {
    if (detailedReadSupported) {
      try { return (await this.call(READ_QUERY_EXTENDED, { id }, signal)).aiConversation; }
      catch (error) { if (error.code !== 'linear_query_unsupported') throw error; detailedReadSupported = false; }
    }
    return (await this.call(READ_QUERY, { id }, signal)).aiConversation;
  }
  async cancel(id) {
    await this.call(CANCEL_QUERY, { id }, AbortSignal.timeout(5000)).catch(() => {});
  }
  /**
   * Sends one user message and polls until the assistant turn completes.
   * `doc` (a Linear rich-text document) takes precedence over `text`.
   * `onProgress({ parts, status })` sees every poll of the current turn.
   */
  async chat({ text, doc, conversationId, requestedModel = MODEL, reasoningEffort }, signal, onAccepted = () => {}, onProgress) {
    const proposedId = conversationId ?? randomUUID();
    const data = await this.call(SEND_QUERY, { input: { conversationId: proposedId, userMessageId: randomUUID(), context: [], bodyData: doc ?? textDoc(text), resume: true, ...(requestedModel === MODEL ? {} : { model: requestedModel }), ...(reasoningEffort ? { reasoningEffort } : {}) } }, signal);
    const sent = data.aiConversationSendMessage;
    if (!sent?.success || !sent.aiConversation?.id || !sent.assistantMessage?.id) throw new GatewayError(502, 'linear_send_failed', 'Linear did not confirm the message.');
    const id = sent.aiConversation.id;
    let complete = false, emptyCompletePolls = 0;
    try {
      await onAccepted(id);
      for (;;) {
        signal?.throwIfAborted();
        const conversation = await this.read(id, signal);
        if (!conversation) throw new GatewayError(502, 'linear_conversation_missing', 'Linear did not return the conversation.');
        const parts = currentTurnParts(conversation, sent.assistantMessage.id);
        if (parts.some(p => p.type === 'error') || ['error', 'cancelled', 'canceled'].includes(conversation.status)) {
          complete = true;
          throw new GatewayError(502, 'linear_agent_error', 'Linear Agent could not complete the reply.');
        }
        if (parts.some(p => p.type === 'elicitation') || !['complete', 'active', 'pending'].includes(conversation.status)) {
          throw new GatewayError(409, 'linear_action_required', 'Linear requires an action in its conversation page (a confirmation for one of its own built-in tools). Client tools are separate.');
        }
        const text = answerText(parts);
        if (conversation.status === 'complete' && !text) emptyCompletePolls++;
        const done = conversation.status === 'complete' && (text || emptyCompletePolls >= EMPTY_COMPLETE_POLLS);
        if (onProgress) await onProgress({ parts, status: conversation.status, complete: Boolean(done) });
        if (done) {
          complete = true;
          return { text, conversationId: id, assistantMessageId: sent.assistantMessage.id, markdown: answerMarkdown(parts), parts: answerParts(parts), linearToolCalls: linearToolCalls(parts) };
        }
        await sleep(this.pollMs, undefined, { signal });
      }
    } finally {
      if (!complete) await this.cancel(id);
    }
  }
}

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

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
const CANCEL_QUERY = `mutation AiConversationCancel($id: String!) {
  aiConversationCancel(id: $id) { success aiConversation { id } }
}`;

export class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

export function answerText(parts) {
  return parts.filter(p => p.type === 'text' && p.metadata?.phase !== 'commentary').map(p => {
    const html = htmlDocumentSource(p.bodyData);
    if (!html) return richText(p.bodyData);
    const fence = '`'.repeat(Math.max(3, ...[...html.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `${fence}html\n${html}\n${fence}`;
  }).filter(Boolean).join('\n\n');
}

function clientToolOptions(body) {
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) throw new GatewayError(400, 'invalid_tools', 'tools must be an array of at most 128 function definitions.');
  const tools = body.tools ?? [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) throw new GatewayError(400, 'invalid_tools', 'Only named function tool definitions are accepted for text-only compatibility.');
  }
  const choice = body.tool_choice ?? 'auto';
  if (choice !== 'auto' && choice !== 'none') {
    if (choice === 'required' || (choice && typeof choice === 'object' && !Array.isArray(choice) && choice.type === 'function' && typeof choice.function?.name === 'string')) throw new GatewayError(400, 'client_tools_unavailable', 'Required client tool calls are not supported. Use tool_choice auto/none for a text reply, or disable tools/MCP in Cherry. Linear built-in tools are separate.');
    throw new GatewayError(400, 'invalid_tool_choice', 'tool_choice must be auto or none for text-only compatibility.');
  }
  if (!tools.length) return null;
  return { client_tools: 'unavailable', ignored_tool_definitions: tools.length, tool_choice: choice };
}

export function validateRequest(body, allowedModels = [MODEL]) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError(400, 'invalid_request', 'Expected a JSON object.');
  const allowed = new Set(['model', 'messages', 'stream', 'stream_options', 'conversation_id', 'account_id', 'tools', 'tool_choice', 'reasoning_effort']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new GatewayError(400, 'unsupported_parameter', `Parameter ${key} is not supported by Linear Agent chat.`);
  if (typeof body.model !== 'string' || !allowedModels.includes(body.model)) throw new GatewayError(400, 'unsupported_model', 'Choose a model from /v1/models. Only the default entry and locally tested model parameters are enabled.');
  const effort = body.reasoning_effort ?? 'auto';
  if (!REASONING_EFFORTS.includes(effort)) throw new GatewayError(400, 'invalid_reasoning_effort', 'reasoning_effort must be auto, low, medium or high. Omit it or use auto to keep the Linear default.');
  if (body.account_id !== undefined && (typeof body.account_id !== 'string' || !/^acct-[a-f0-9]{20}$/.test(body.account_id))) throw new GatewayError(400, 'invalid_account', 'account_id must be an ID returned by /v1/accounts.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new GatewayError(400, 'invalid_request', 'stream must be a boolean.');
  if (body.stream_options !== undefined && (!body.stream || !body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) throw new GatewayError(400, 'invalid_request', 'stream_options supports only include_usage with stream=true. Token usage is unavailable.');
  const compatibility = clientToolOptions(body);
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) throw new GatewayError(400, 'invalid_messages', 'messages must be a non-empty array.');
  const normalized = messages.map(m => {
    if (!m || !['system', 'developer', 'user', 'assistant'].includes(m.role) || m.tool_calls || m.function_call) throw new GatewayError(400, 'unsupported_message', 'Only text system/developer/user/assistant messages are supported.');
    let content = m.content;
    if (Array.isArray(content) && content.every(p => p?.type === 'text' && typeof p.text === 'string')) content = content.map(p => p.text).join('\n');
    if (typeof content !== 'string') throw new GatewayError(400, 'unsupported_content', 'Only text content is supported.');
    return { role: m.role, content };
  });
  if (normalized.at(-1).role !== 'user' || !normalized.at(-1).content.trim()) throw new GatewayError(400, 'invalid_messages', 'The final message must contain user text.');
  if (body.conversation_id !== undefined) {
    if (typeof body.conversation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.conversation_id)) throw new GatewayError(400, 'invalid_conversation', 'conversation_id must be a UUID.');
    if (normalized.length !== 1) throw new GatewayError(400, 'invalid_messages', 'When continuing conversation_id, send only the new user message.');
  }
  const history = normalized.length === 1 ? normalized[0].content : '以下是调用方提供的对话历史，请根据这些内容回复最后一条用户消息。\n\n' + normalized.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
  const text = compatibility ? '本次客户端只接收最终文本回复；客户端提供的外部工具未连接，无法调用它们。对代码生成任务，请在回复中直接给出完整代码。\n\n' + history : history;
  return { text, requestedModel: body.model, accountId: body.account_id, conversationId: body.conversation_id, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, ...(effort === 'auto' ? {} : { reasoningEffort: effort }), ...(compatibility ? { compatibility } : {}) };
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
      const auth = [401, 403].includes(response.status) || result.errors?.some(e => /AUTHENTICATION|UNAUTHENTICATED/.test(e.extensions?.code ?? ''));
      if (auth) throw new GatewayError(503, 'linear_session_expired', 'Linear authentication failed. Refresh the local login session.');
      if (response.status === 429) throw new GatewayError(429, 'linear_rate_limit', 'Linear rate limit reached. Please wait before trying again.');
      throw new GatewayError(502, 'linear_upstream_error', 'Linear rejected the chat request.');
    }
    if (!result.data) throw new GatewayError(502, 'linear_invalid_response', 'Linear returned no data.');
    return result.data;
  }
  async chat({ text, conversationId, requestedModel = MODEL, reasoningEffort }, signal, onAccepted = () => {}) {
    const proposedId = conversationId ?? randomUUID();
    const data = await this.call(SEND_QUERY, { input: { conversationId: proposedId, userMessageId: randomUUID(), context: [], bodyData: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, resume: true, ...(requestedModel === MODEL ? {} : { model: requestedModel }), ...(reasoningEffort ? { reasoningEffort } : {}) } }, signal);
    const sent = data.aiConversationSendMessage;
    if (!sent?.success || !sent.aiConversation?.id || !sent.assistantMessage?.id) throw new GatewayError(502, 'linear_send_failed', 'Linear did not confirm the message.');
    const id = sent.aiConversation.id;
    let complete = false;
    try {
      await onAccepted(id);
      for (;;) {
        signal?.throwIfAborted();
        const { aiConversation: conversation } = await this.call(READ_QUERY, { id }, signal);
        if (!conversation) throw new GatewayError(502, 'linear_conversation_missing', 'Linear did not return the conversation.');
        const parts = currentTurnParts(conversation, sent.assistantMessage.id);
        if (parts.some(p => p.type === 'error') || ['error', 'cancelled', 'canceled'].includes(conversation.status)) {
          complete = true;
          throw new GatewayError(502, 'linear_agent_error', 'Linear Agent could not complete the reply.');
        }
        if (parts.some(p => p.type === 'elicitation') || !['complete', 'active', 'pending'].includes(conversation.status)) {
          throw new GatewayError(409, 'linear_action_required', 'Linear requires an action in its conversation page.');
        }
        const text = answerText(parts);
        if (conversation.status === 'complete' && text) {
          complete = true;
          return { text, conversationId: id };
        }
        await sleep(this.pollMs, undefined, { signal });
      }
    } finally {
      if (!complete) await this.call(CANCEL_QUERY, { id }, AbortSignal.timeout(5000)).catch(() => {});
    }
  }
}

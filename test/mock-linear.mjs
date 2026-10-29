// A scripted stand-in for client-api.linear.app used by the automated tests.
// It implements the three operations the gateway uses (send, read, cancel) on top
// of an in-memory conversation store, converts the scripted model's Markdown into
// Linear-style rich text, and can reveal a reply over several polls. It never
// contacts Linear and consumes no account quota.

import { randomUUID } from 'node:crypto';
import { ENDPOINT, LinearClient } from '../upstream.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_INPUT_NODES = new Set(['doc', 'paragraph', 'text', 'hard_break', 'heading', 'code_block']);

function inlineNodes(text) {
  const nodes = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) });
    nodes.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

/** Minimal Markdown → Linear rich text: fences, headings, bullet lists, paragraphs, inline code. */
export function markdownToDoc(markdown, { keepFenceInfo = true } = {}) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const content = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) { const text = paragraph.join('\n'); if (text.trim()) content.push({ type: 'paragraph', content: inlineNodes(text) }); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flush();
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = lines[j].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) break;
        body.push(lines[j]);
      }
      const language = keepFenceInfo ? fence[2].trim().split(/\s+/)[0] || null : null;
      const text = body.join('\n');
      content.push({ type: 'code_block', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) });
      i = j;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flush(); content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inlineNodes(heading[2]) }); continue; }
    if (/^- /.test(line)) {
      flush();
      const items = [];
      for (; i < lines.length && /^- /.test(lines[i]); i++) items.push({ type: 'list_item', content: [{ type: 'paragraph', content: inlineNodes(lines[i].slice(2)) }] });
      i--;
      content.push({ type: 'bullet_list', content: items });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  return { type: 'doc', content };
}

/** Plain text of a rich-text document (what a model would "read"). */
export function docText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hard_break') return '\n';
  const children = (node.content ?? []).map(docText);
  if (node.type === 'doc') return children.join('\n\n');
  if (node.type === 'code_block') return '```' + (node.attrs?.language ?? '') + '\n' + children.join('') + '\n```';
  return children.join('');
}

/** [{ label, code }] pairs from a gateway transcript document. */
export function labelledBlocks(doc) {
  const pairs = [];
  const content = doc?.content ?? [];
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    if (node.type !== 'paragraph') continue;
    const label = docText(node);
    if (!/^\[[^\]]+\]$/.test(label)) continue;
    const next = content[i + 1];
    if (next?.type === 'code_block') pairs.push({ label, language: next.attrs?.language, code: (next.content ?? []).map(n => n.text).join('') });
  }
  return pairs;
}

export const nonceOf = doc => [...docText(doc).matchAll(/Nonce for this reply: (lgw-[a-z0-9]+)/g)].at(-1)?.[1] ?? null;

export function toolCallBlock(nonce, calls, intro = '') {
  return (intro ? intro + '\n\n' : '') + '```tool_calls\n' + JSON.stringify({ nonce, tool_calls: calls }) + '\n```';
}

function graphqlError(message, code, status = 400) {
  return new Response(JSON.stringify({ errors: [{ message, extensions: { code } }] }), { status, headers: { 'content-type': 'application/json' } });
}
const ok = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });

const PLAIN_INPUT_NODES = new Set(['doc', 'paragraph', 'text']);

function validateInputDoc(node, allowed, path = 'bodyData') {
  if (!node || typeof node !== 'object' || !allowed.has(node.type)) return `${path} has an unsupported node`;
  if (node.type === 'text' && (typeof node.text !== 'string' || !node.text)) return `${path} has an empty text node`;
  if (node.content !== undefined && !Array.isArray(node.content)) return `${path}.content must be an array`;
  for (const [index, child] of (node.content ?? []).entries()) { const problem = validateInputDoc(child, allowed, `${path}.content[${index}]`); if (problem) return problem; }
  return null;
}

/**
 * new MockLinear({ model }) where model(turn) returns
 * { markdown, internalTools?, chunks?, error?, status?, waitPolls?, commentary?, hold?, body?, bodyData? } for each sent message.
 * `hold: true` keeps the turn active (with no answer text, like Linear's GraphQL during
 * generation) until `release(turnId)`; `body`/`bodyData` override the final rendering.
 */
export class MockLinear {
  constructor({ model, detailedRead = true, keepFenceInfo = true, richInput = true, onSend } = {}) {
    this.model = model;
    this.allowedNodes = richInput ? ALLOWED_INPUT_NODES : PLAIN_INPUT_NODES;
    this.rejectedSends = 0;
    this.detailedRead = detailedRead;
    this.keepFenceInfo = keepFenceInfo;
    this.onSend = onSend;
    this.conversations = new Map();
    this.turnsById = new Map();
    this.sends = [];
    this.reads = 0;
    this.cancels = [];
    this.activeTurns = 0;
    this.maximumActiveTurns = 0;
    this.fetch = this.fetch.bind(this);
  }
  client(options = {}) {
    const headers = { cookie: 'MOCK_ONLY_COOKIE', user: 'mock-user', organization: 'mock-org', ...options.headers };
    return new LinearClient({ headers }, { fetchImpl: this.fetch, pollMs: options.pollMs ?? 1, realtime: options.realtime ?? null });
  }
  /** Lets a held turn complete on the next GraphQL read. */
  release(turnId) {
    const entry = this.turnsById.get(turnId);
    if (entry) entry.turn.held = false;
  }
  get conversationCount() { return this.conversations.size; }
  async fetch(url, options) {
    if (url !== ENDPOINT) throw new Error('Mock received an unexpected URL');
    if (options.signal?.aborted) throw options.signal.reason;
    const { query, variables } = JSON.parse(options.body);
    if (query.startsWith('mutation AiConversationSendMessage')) return this.send(variables.input);
    if (query.startsWith('mutation AiConversationCancel')) {
      this.cancels.push(variables.id);
      const conversation = this.conversations.get(variables.id);
      if (conversation?.turn && conversation.status !== 'complete') { conversation.status = 'complete'; conversation.turn.cancelled = true; this.finishTurn(conversation); }
      return ok({ aiConversationCancel: { success: true, aiConversation: { id: variables.id } } });
    }
    if (query.startsWith('query LinearAgentReadDetailed')) {
      if (!this.detailedRead) return graphqlError('Cannot query field "body" on type "AiConversationTextPart".', 'GRAPHQL_VALIDATION_FAILED');
      return this.read(variables.id, true);
    }
    if (query.startsWith('query LinearAgentRead')) return this.read(variables.id, false);
    return graphqlError('Unknown operation', 'GRAPHQL_VALIDATION_FAILED');
  }
  async send(input) {
    if (!UUID.test(input.conversationId ?? '') || !UUID.test(input.userMessageId ?? '') || input.resume !== true || !Array.isArray(input.context)) return graphqlError('Invalid AiConversationSendMessageInput', 'INVALID_INPUT');
    const problem = validateInputDoc(input.bodyData, this.allowedNodes);
    if (problem) { this.rejectedSends++; return graphqlError('Variable "$input" got invalid value: ' + problem, 'BAD_USER_INPUT'); }
    let conversation = this.conversations.get(input.conversationId);
    if (!conversation) { conversation = { id: input.conversationId, status: 'complete', parts: [], turns: [] }; this.conversations.set(conversation.id, conversation); }
    if (conversation.status !== 'complete') return graphqlError('Conversation is busy', 'CONFLICT');
    const turnId = 'turn-' + randomUUID();
    const turnNumber = conversation.turns.length;
    const record = { conversationId: conversation.id, turnId, input, turnNumber };
    this.sends.push(record);
    this.onSend?.(record);
    conversation.parts.push({ __typename: 'AiConversationPromptPart', id: input.userMessageId, type: 'prompt', metadata: { turnId: input.userMessageId, phase: null } });
    const reply = await this.model({ conversation, input, doc: input.bodyData, text: docText(input.bodyData), turnNumber, sendIndex: this.sends.length - 1 }) ?? { markdown: '' };
    const turn = { id: turnId, reply, polls: 0, revealed: 0, chunks: Math.max(1, reply.chunks ?? 1), waitPolls: reply.waitPolls ?? 0, cancelled: false, held: reply.hold === true };
    conversation.turns.push(turn);
    this.turnsById.set(turnId, { conversation, turn });
    conversation.turn = turn;
    conversation.status = 'active';
    this.activeTurns++;
    this.maximumActiveTurns = Math.max(this.maximumActiveTurns, this.activeTurns);
    return ok({ aiConversationSendMessage: { success: true, lastSyncId: 1, aiConversation: { id: conversation.id }, userMessage: { id: input.userMessageId }, assistantMessage: { id: turnId } } });
  }
  finishTurn(conversation) {
    if (conversation.turn && !conversation.turn.finished) { conversation.turn.finished = true; this.activeTurns--; }
  }
  advance(conversation) {
    const turn = conversation.turn;
    if (!turn || conversation.status !== 'active') return;
    turn.polls++;
    if (turn.polls <= turn.waitPolls || turn.held) return;
    const { reply } = turn;
    conversation.parts = conversation.parts.filter(p => p.metadata?.turnId !== turn.id);
    if (reply.error) {
      conversation.parts.push({ __typename: 'AiConversationErrorPart', id: turn.id + ':e', type: 'error', metadata: { turnId: turn.id, phase: 'answer' }, message: 'Something went wrong.' });
      conversation.status = 'error';
      this.finishTurn(conversation);
      return;
    }
    if (reply.status) { conversation.status = reply.status; return; }
    for (const [index, name] of (reply.internalTools ?? []).entries()) conversation.parts.push({ __typename: 'AiConversationToolCallPart', id: `${turn.id}:tool${index}`, type: 'toolCall', metadata: { turnId: turn.id, phase: 'commentary' }, toolCall: { __typename: `AiConversation${name}ToolCall`, name } });
    if (reply.commentary) conversation.parts.push({ __typename: 'AiConversationTextPart', id: turn.id + ':c', type: 'text', metadata: { turnId: turn.id, phase: 'commentary' }, body: reply.commentary, bodyData: markdownToDoc(reply.commentary) });
    turn.revealed = Math.min(turn.chunks, turn.revealed + 1);
    const markdown = reply.markdown ?? '';
    const complete = turn.revealed >= turn.chunks;
    const visible = complete ? markdown : markdown.slice(0, Math.floor(markdown.length * turn.revealed / turn.chunks));
    if (visible) conversation.parts.push({ __typename: 'AiConversationTextPart', id: turn.id + ':0', type: 'text', metadata: { turnId: turn.id, phase: 'answer', startedAt: 'start', ...(complete ? { endedAt: 'end' } : {}) }, body: complete && reply.body !== undefined ? reply.body : visible, bodyData: complete && reply.bodyData ? reply.bodyData : markdownToDoc(visible, { keepFenceInfo: this.keepFenceInfo }) });
    if (complete) { conversation.status = 'complete'; this.finishTurn(conversation); }
  }
  read(id, detailed) {
    this.reads++;
    const conversation = this.conversations.get(id);
    if (!conversation) return ok({ aiConversation: null });
    this.advance(conversation);
    const parts = conversation.parts.map(part => {
      if (detailed) return part;
      const { body, toolCall, ...rest } = part;
      return { ...rest, metadata: { phase: part.metadata?.phase ?? null, turnId: part.metadata?.turnId } };
    });
    return ok({ aiConversation: { id, status: conversation.status, parts } });
  }
}

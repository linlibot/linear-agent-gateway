// POST /v1/chat/completions: request scheduling, account attempts, Linear turns,
// client tool protocol, streaming and duplicate protection.

import { createHash, randomUUID } from 'node:crypto';
import { GatewayError, LinearClient, loadSession, normalizeSession, MODEL, READ_QUERY, validateRequest } from './upstream.mjs';
import { canFailOver } from './routing.mjs';
import { ChatStream } from './sse.mjs';
import { LiveText } from './progressive.mjs';
import { REALTIME_URL, createTiming, isLinearRealtimeUrl, realtimeFactory } from './realtime.mjs';
import { newNonce, parseToolReply, toOpenAiToolCalls, toolsFingerprint } from './tool-protocol.mjs';
import { continuationDocument, initialDocument, repairDocument } from './prompt-builder.mjs';
import { chainHash, FILE_CHANGE_TOOL, historyHasFileChanges, prefixHashes, toolCallNames } from './messages.mjs';

// Linear built-in tools whose files and effects stay in Linear's cloud environment.
export const LINEAR_CLOUD_WORK_TOOLS = new Set(['Bash', 'CodeMode', 'CodeIntelligence', 'CreateSandbox', 'ReadSandboxFile', 'SandboxGitHistory', 'StartCodingSession', 'HandoffToCodingSession', 'PromptCodingSession', 'ReadFile']);
const CLAIM = /(已经|已|成功|帮你|为你)\s*(创建|新建|写入|保存|修改|更新|生成|编辑)|\b(?:I|We)(?:'ve| have)?\s+(?:created|written|wrote|saved|updated|modified|edited)\b|\bha(?:s|ve) been (?:created|written|saved|updated|modified)\b/i;
const FILE_HINT = /\b[\w-]+\.[a-z][a-z0-9]{0,7}\b|文件|\bfiles?\b|路径|\bpaths?\b/i;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const CONTINUATION_BROKEN = new Set(['linear_upstream_error', 'linear_send_failed', 'linear_invalid_response', 'linear_conversation_missing', 'linear_network_error']);

// Set when Linear rejected a rich-text (code block) message but accepted the same content as
// one plain paragraph; later tool requests then use the plain format directly.
export const promptFormatState = { richRejected: false, reset() { this.richRejected = false; } };

export const DEFAULT_CHAT_SETTINGS = Object.freeze({ clientTools: 'structured', strictParameters: false, streamMode: 'incremental', toolRepairAttempts: 1, toolContinuation: 'native', promptFormat: 'rich', maxPromptChars: 1_000_000 });

function cloudNotice(tools) {
  const names = [...new Set(tools)];
  return `[网关提示] 本轮没有发出任何客户端工具调用，你的本地文件没有被创建或修改。Linear 在其云端执行了内置工具（${names.join('、')}），回复中提到的文件或路径位于 Linear 云端环境，不在你的电脑上。\n[Gateway notice] No client tool call was issued, so no local file was created or changed. Linear ran its own cloud tools (${names.join(', ')}); files or paths mentioned above are in Linear's cloud environment, not on your computer.`;
}
const CLAIM_NOTICE = '[网关提示] 这条回复描述了文件改动，但网关没有向客户端发出任何文件工具调用，你的本地文件没有被创建或修改。\n[Gateway notice] This reply describes file changes, but no client tool call was issued, so no local file was created or changed.';

function appendNotice(content, text) {
  return content ? content + '\n\n' + text : text;
}

function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return i;
  return -1;
}

export function createChatCompletions({ accountStore, accountRouter, clientKeys, sessionFile, modelsProvider, catalog, clientFactory, pollMs, timeoutMs, scheduler, toolSessions, settings: overrides = {}, realtime = null, onError = () => {}, onTiming = () => {}, controllers }) {
  const settings = { ...DEFAULT_CHAT_SETTINGS, ...overrides };
  // Realtime channels for clients built here; off unless the server configured them. The
  // session cookie travels on that socket, so only Linear's own wss hosts are accepted.
  if (realtime && realtime.mode !== 'off' && !isLinearRealtimeUrl(realtime.url ?? REALTIME_URL)) throw new Error('Invalid realtime URL: use a wss:// URL on a linear.app host.');
  const channels = realtime ? realtimeFactory(realtime, { WebSocketImpl: realtime.WebSocketImpl }) : null;

  /**
   * SSE writer for one turn: realtime text and stable polled text, whichever arrives first.
   * `x-linear-realtime: off` on a request keeps it on polling (for A/B timing checks); it
   * cannot turn realtime on when the server disabled it.
   */
  function liveStream(stream, timing, stopAtCode, input) {
    if (!stream || settings.streamMode !== 'incremental') return null;
    const live = new LiveText({ stopAtCode });
    let latest = null;
    const write = text => {
      if (!text || !stream.started) return;
      timing.mark('first_text');
      stream.content(text);
    };
    return {
      live, write,
      onProgress: async ({ parts, complete }) => { if (!complete && stream.started) write(live.fromPolls(parts)); },
      options: { realtime: input.realtime !== false, timing, onRealtime: turn => { latest = turn; if (stream.started) write(live.fromRealtime(turn)); } },
      // Realtime text can arrive before the SSE response has started.
      accept: onAccepted => async id => { await onAccepted(id); if (latest) write(live.fromRealtime(latest)); },
    };
  }

  async function continuationFor(input, explicitAccount, toolsHash) {
    // An explicit conversation_id always continues that conversation, whatever the setting.
    if (input.conversationId) {
      const session = toolSessions?.findByConversation(input.conversationId) ?? null;
      if (session && (session.clientScope ?? 'legacy') !== input.clientScope) throw new GatewayError(409, 'tool_session_mismatch', 'This tool session belongs to another client API key.');
      const [first] = input.messages;
      if (first.role === 'assistant') {
        const ids = first.toolCalls.map(c => c.id);
        if (!session || session.toolCallIds?.length !== ids.length || session.toolCallIds.some((id, i) => id !== ids[i])) throw new GatewayError(409, 'tool_session_mismatch', 'These tool results do not answer the latest tool calls of this conversation. Send the full message history without conversation_id instead.');
      }
      if (session && !toolSessions.claim(session)) throw new GatewayError(409, 'conversation_busy', 'This conversation is already processing another request.');
      return { session: session ?? undefined, explicit: true, delta: first.role === 'assistant' ? input.messages.slice(1) : input.messages, conversationId: input.conversationId, includeProtocol: !session?.protocolSent, toolsChanged: session?.toolsHash !== toolsHash };
    }
    if (!toolSessions || settings.toolContinuation !== 'native') return null;
    const index = lastAssistantIndex(input.messages);
    if (index < 0) return null;
    const session = toolSessions.findByPrefix(input.hashes[index]);
    if (!session) return null;
    if (explicitAccount && session.accountId !== explicitAccount.id) return null;
    if (session.accountId && accountStore) {
      try { await accountStore.get(session.accountId); } catch { return null; }
      if (accountRouter && (await accountRouter.status()).accounts.find(a => a.id === session.accountId)?.status !== 'ready') return null;
      if (!(await modelsProvider(session.accountId)).some(m => m.id === input.requestedModel)) return null;
    }
    if (!toolSessions.claim(session)) throw new GatewayError(409, 'conversation_busy', 'This tool conversation is already processing a request.');
    return { session, explicit: false, delta: input.messages.slice(index + 1), conversationId: session.conversationId, accountId: session.accountId, includeProtocol: !session.protocolSent, toolsChanged: session.toolsHash !== toolsHash };
  }

  return async function handle(req, res, { body, clientKey }) {
    let account = accountStore && (!accountRouter || body.account_id !== undefined || body.conversation_id !== undefined) ? await accountStore.resolve({ accountId: body.account_id, conversationId: body.conversation_id }) : null;
    const input = validateRequest(body, (await (account ? modelsProvider(account.id) : catalog())).map(m => m.id), { clientTools: settings.clientTools, strictParameters: settings.strictParameters });
    input.clientScope = clientKey?.id ?? 'legacy';
    input.realtime = !/^off$/i.test(String(req.headers['x-linear-realtime'] ?? '').trim());
    const ticket = scheduler.admit();
    const controller = new AbortController();
    controllers.add(controller);
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new GatewayError(504, 'linear_timeout', 'Linear reply timed out.')), timeoutMs);
    const disconnect = () => controller.abort(new GatewayError(499, 'client_disconnected', 'Client disconnected.'));
    req.once('aborted', disconnect);
    res.once('close', () => { if (!res.writableEnded) disconnect(); });
    const id = 'chatcmpl-' + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const stream = input.stream ? new ChatStream(res, { id, created }) : null;
    const timing = createTiming();
    // One log line per answered request: timings and fallback reason, never content.
    const report = (outcome, error) => {
      try {
        const channel = outcome?.response?.final?.streaming?.realtime ?? error?.realtime ?? null;
        onTiming({ event: 'chat_timing', mode: input.mode, stream: input.stream, ...(error ? { error: error.code ?? 'internal_error' } : {}), source: outcome?.response?.final?.streaming?.source ?? null, realtime: channel?.status ?? 'off', ...(channel?.fallback_reason ? { fallback_reason: channel.fallback_reason } : {}), ...timing.snapshot() });
      } catch {}
    };
    let releaseGlobal, requestKey = null, continuation = null, sessionDone = false;
    try {
      releaseGlobal = await scheduler.acquireGlobal(signal);
      signal.throwIfAborted();
      if (clientKey) await clientKeys.begin(clientKey.id);
      let completed = false;
      try {
        const toolMode = input.mode === 'tools';
        const toolsHash = toolMode ? sha256(toolsFingerprint(input.tools)) : null;
        if (toolMode && toolSessions) {
          // Scope history matching and duplicate replies to the authenticated client.
          input.hashes = prefixHashes(input.messages, input.clientScope);
          requestKey = sha256(JSON.stringify([input.hashes.at(-1), input.requestedModel, input.reasoningEffort ?? null, toolsHash, input.choice, input.parallelToolCalls, input.accountId ?? null, input.conversationId ?? null]));
          // Only mid-loop requests (ending with tool results) are answered from the duplicate
          // cache, so a user who regenerates a reply still gets a fresh one.
          const cacheable = input.messages.at(-1).role === 'tool' && !/no-cache|no-store/i.test(req.headers['cache-control'] ?? '');
          const cached = cacheable ? toolSessions.cached(requestKey) : null;
          if (cached) { replay(res, stream, cached, input, { id, created }); completed = true; return; }
          input.cacheable = cacheable;
          if (!toolSessions.beginRequest(requestKey)) { requestKey = null; throw Object.assign(new GatewayError(409, 'duplicate_request_in_progress', 'An identical request is already being processed. Wait for its response instead of resending it.'), { retryAfter: 5 }); }
          toolSessions.assertReplaySafe(requestKey);
          input.requestKey = requestKey;
        }
        if (toolMode) continuation = await continuationFor(input, input.accountId !== undefined ? account : null, toolsHash);
        const outcome = await attempts({ input, account, continuation, signal, res, stream, ids: { id, created }, timing });
        if (toolMode && toolSessions) {
          const { result, accountUsed, response } = outcome;
          const assistant = { role: 'assistant', content: response.content, toolCalls: response.toolCalls.map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) };
          // Explicit conversation_id continuations are keyed by conversation; others by history.
          const prefixHash = input.conversationId ? 'conversation:' + result.conversationId : chainHash(input.hashes.at(-1), assistant);
          toolSessions.record({ session: continuation?.session ?? null, accountId: accountUsed?.id ?? null, conversationId: result.conversationId, prefixHash, toolsHash, protocolSent: response.protocolSent, toolCallIds: assistant.toolCalls.map(c => c.id), droppedCalls: response.droppedCalls, clientScope: input.clientScope });
          sessionDone = true;
          if (input.cacheable) toolSessions.remember(requestKey, { ...response, conversationId: result.conversationId, accountId: accountUsed?.id ?? null }, JSON.stringify(response).length);
          else await toolSessions.clearDispatched(requestKey);
        }
        if (signal.aborted || res.destroyed) return;
        outcome.send();
        completed = true;
        report(outcome);
      } finally {
        if (clientKey) await clientKeys.finish(clientKey.id, completed).catch(() => onError({ code: 'key_store_unavailable', status: 503 }));
      }
    } catch (cause) {
      // Once Linear accepted the continuation, its conversation holds a turn the client never
      // received; that conversation must not be continued again. A conversation Linear refuses
      // to continue (e.g. deleted in the Linear app) is also abandoned, so retries replay instead
      // of failing forever.
      if (continuation?.session && !sessionDone && (continuation.accepted || CONTINUATION_BROKEN.has(cause?.code))) toolSessions.markDirty(continuation.session);
      const failure = signal.aborted ? signal.reason : cause;
      if (timing.has('send_start')) report(null, { code: failure?.code, realtime: cause?.realtime });
      throw failure;
    } finally {
      if (continuation?.session && !sessionDone) toolSessions?.release(continuation.session);
      if (requestKey) toolSessions.endRequest(requestKey);
      clearTimeout(timer);
      stream?.stop();
      releaseGlobal?.();
      ticket.release();
      controllers.delete(controller);
    }
  };

  function replay(res, stream, cached, input, { id, created }) {
    res.setHeader('x-linear-idempotent-replay', 'true');
    if (cached.conversationId) res.setHeader('x-linear-conversation-id', cached.conversationId);
    if (cached.accountId) res.setHeader('x-linear-account-id', cached.accountId);
    const metadata = { ...cached.selection, idempotent_replay: true };
    const finish = cached.toolCalls.length ? 'tool_calls' : 'stop';
    if (stream) {
      stream.start(metadata);
      stream.content(cached.content ?? '');
      if (cached.toolCalls.length) stream.toolCalls(cached.toolCalls);
      stream.finish(finish, cached.final, input.includeUsage);
    } else json(res, 200, { id, object: 'chat.completion', created, model: MODEL, ...metadata, ...cached.final, choices: [{ index: 0, message: { role: 'assistant', content: cached.content, ...(cached.toolCalls.length ? { tool_calls: cached.toolCalls } : {}) }, finish_reason: finish }], usage: null, conversation_id: cached.conversationId });
  }

  async function attempts({ input, account, continuation, signal, res, stream, ids, timing }) {
    const fixedAccount = continuation && !continuation.explicit ? (accountStore && continuation.accountId ? await accountStore.get(continuation.accountId) : null) : undefined;
    const planFor = async () => {
      if (fixedAccount !== undefined) return { accounts: [fixedAccount], strategy: 'tool_session', failover_enabled: false };
      return accountRouter ? accountRouter.plan(input) : { accounts: [account], strategy: 'fixed', failover_enabled: false };
    };
    const attempted = [];
    let plan = null;
    const routingInfo = () => ({ strategy: plan.strategy, attempt_count: attempted.length, failover_count: Math.max(0, attempted.length - 1), attempted_account_ids: [...attempted] });
    for (;;) {
      signal.throwIfAborted();
      const { candidate, release } = await dispatch();
      let accepted = false;
      try {
        account = accountRouter && candidate ? { ...await accountStore.get(candidate.id), needsConversationCheck: candidate.needsConversationCheck } : candidate;
      } catch (error) { release(); throw error; }
      attempted.push(account?.id ?? null);
      try {
        const client = clientFactory ? await clientFactory(account) : new LinearClient(account ? normalizeSession(account.session) : await loadSession(sessionFile), { pollMs, realtime: channels });
        if (account?.needsConversationCheck) {
          let conversation;
          try { conversation = (await client.call(READ_QUERY, { id: input.conversationId }, signal)).aiConversation; }
          catch (error) { if (error.code !== 'linear_upstream_error') throw error; }
          if (!conversation) throw new GatewayError(409, 'conversation_account_unknown', 'Cannot access this conversation with the selected account. Choose its original account or start a new conversation.');
        }
        const selection = { requested_model: input.requestedModel === MODEL ? null : input.requestedModel, model_selection_verified: false, requested_reasoning_effort: input.reasoningEffort ?? null, reasoning_effort_verified: false, account_id: account?.id ?? null, ...(accountRouter ? { routing: routingInfo() } : {}), ...(input.compatibility ? { compatibility: input.compatibility } : {}), ...(input.mode === 'tools' ? { client_tools: { mode: 'structured_output', experimental: true, tool_session: continuation ? 'native' : lastAssistantIndex(input.messages) >= 0 ? 'replay' : 'new' } } : {}), ...(input.ignoredParameters.length ? { ignored_parameters: input.ignoredParameters } : {}) };
        const onAccepted = async conversationId => {
          // Once Linear accepts a send, replay could duplicate its native tool actions.
          accepted = true;
          if (continuation) continuation.accepted = true;
          if (account) await accountStore.pin(conversationId, account.id);
          signal.throwIfAborted();
          res.setHeader('x-linear-conversation-id', conversationId);
          res.setHeader('x-linear-requested-model', input.requestedModel);
          res.setHeader('x-linear-requested-reasoning-effort', input.reasoningEffort ?? 'auto');
          if (input.compatibility) res.setHeader('x-linear-client-tools', 'unavailable; text-only');
          if (input.mode === 'tools') { res.setHeader('x-linear-client-tools', 'structured-output; experimental'); res.setHeader('x-linear-tool-session', selection.client_tools.tool_session); }
          if (input.ignoredParameters.length) res.setHeader('x-linear-ignored-parameters', input.ignoredParameters.join(','));
          if (account) res.setHeader('x-linear-account-id', account.id);
          if (accountRouter) {
            res.setHeader('x-linear-attempts', String(attempted.length));
            res.setHeader('x-linear-routing-strategy', plan.strategy);
          }
          if (stream) stream.start(selection);
        };
        if (input.requestKey) await toolSessions.markDispatched(input.requestKey);
        const outcome = input.mode === 'tools'
          ? await toolTurns({ client, input, continuation, signal, onAccepted, stream, selection, res, ids, timing })
          : await chatTurn({ client, input, signal, onAccepted, stream, selection, res, ids, timing });
        if (accountRouter) await accountRouter.recordSuccess(account).catch(() => onError({ code: 'routing_store_unavailable', status: 503 }));
        return { ...outcome, accountUsed: account };
      } catch (error) {
        if (input.requestKey && !accepted && (canFailOver(error) || error.invalidInput)) await toolSessions.clearDispatched(input.requestKey);
        let recorded = true;
        if (accountRouter && account) await accountRouter.recordFailure(account, error).catch(() => { recorded = false; onError({ code: 'routing_store_unavailable', status: 503 }); });
        if (accountRouter && plan.failover_enabled && recorded && !accepted && canFailOver(error) && attempted.length < plan.accounts.length && !signal.aborted) continue;
        if (accountRouter && error instanceof GatewayError) error.routing = routingInfo();
        throw error;
      } finally { release(); }
    }

    async function dispatch() {
      for (;;) {
        const generation = scheduler.generation;
        const picked = await scheduler.exclusive(async () => {
          signal.throwIfAborted();
          if (!attempted.length) plan = await planFor();
          const candidates = plan.accounts.filter(a => !attempted.includes(a?.id ?? null));
          for (const candidate of candidates) {
            const release = scheduler.tryAccount(candidate?.id ?? 'default');
            if (!release) continue;
            try { if (accountRouter && candidate) await accountRouter.recordAttempt(candidate, { advanceCursor: plan.strategy === 'round_robin' }); }
            catch (error) { release(); throw error; }
            return { candidate, release };
          }
          return null;
        });
        if (picked) return picked;
        await scheduler.waitForRelease(generation, signal);
      }
    }
  }

  function streamingReport(live, result) {
    return { ...live.report(), ...(result?.realtime ? { realtime: result.realtime } : {}) };
  }

  async function chatTurn({ client, input, signal, onAccepted, stream, selection, res, ids, timing }) {
    const sse = liveStream(stream, timing, false, input);
    const live = sse?.live ?? null;
    const result = await client.chat({ text: input.text, conversationId: input.conversationId, requestedModel: input.requestedModel, reasoningEffort: input.reasoningEffort }, signal, sse ? sse.accept(onAccepted) : onAccepted, sse?.onProgress, sse ? sse.options : { timing });
    if (!result.text) throw new GatewayError(502, 'linear_empty_reply', 'Linear finished the turn without a text reply.');
    const internal = result.linearToolCalls ?? [];
    const cloud = internal.filter(name => LINEAR_CLOUD_WORK_TOOLS.has(name));
    // Parts streamed in realtime keep the model's own Markdown; the rest is Linear's rendering.
    const answer = live ? live.compose(result, result.turn) : result.text;
    // Only when the reply talks about files: a sandbox calculation needs no warning.
    const content = cloud.length && FILE_HINT.test(answer) ? appendNotice(answer, cloudNotice(cloud)) : answer;
    const final = { ...(internal.length ? { linear_internal_tool_calls: internal } : {}), ...(live ? { streaming: streamingReport(live, result) } : {}) };
    return {
      result,
      response: { content, toolCalls: [], selection, final },
      send() {
        if (signal.aborted || res.destroyed) return;
        if (stream) {
          const rest = live ? live.finish(content) : content;
          if (live) final.streaming = streamingReport(live, result);
          if (rest) { timing.mark('first_text'); stream.content(rest); }
          timing.mark('finish');
          stream.finish('stop', { ...final, timings: timing.snapshot() }, input.includeUsage);
        } else {
          timing.mark('first_text');
          timing.mark('finish');
          json(res, 200, { id: ids.id, object: 'chat.completion', created: ids.created, model: MODEL, ...selection, ...final, timings: timing.snapshot(), choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: null, conversation_id: result.conversationId });
        }
      },
    };
  }

  async function toolTurns({ client, input, continuation, signal, onAccepted, stream, selection, res, ids, timing }) {
    const { tools, choice, parallelToolCalls: parallel } = input;
    let format = settings.promptFormat === 'rich' && promptFormatState.richRejected ? 'plain' : settings.promptFormat;
    const names = toolCallNames(input.messages);
    let nonce = newNonce();
    const includeProtocol = continuation ? continuation.includeProtocol : true;
    const buildDocument = () => continuation
      ? continuationDocument({ delta: continuation.delta, tools, choice, parallel, nonce, format, names, includeProtocol, toolsChanged: continuation.toolsChanged, droppedCalls: continuation.session?.droppedCalls ?? [] })
      : initialDocument({ messages: input.messages, tools, choice, parallel, nonce, format, names });
    const builder = buildDocument();
    if (builder.length > settings.maxPromptChars) throw new GatewayError(413, 'prompt_too_large', `The tool transcript has ${builder.length} characters, above LINEAR_MAX_PROMPT_CHARS (${settings.maxPromptChars}).`);
    // Tool mode streams only complete text lines before anything protocol-like; tool calls
    // are sent after the whole reply was parsed and validated.
    const sse = liveStream(stream, timing, choice.mode !== 'none', input);
    const live = sse?.live ?? null;
    const request = { requestedModel: input.requestedModel, reasoningEffort: input.reasoningEffort };
    let sent = false;
    const accept = async id => { sent = true; await onAccepted(id); };
    const accepted = sse ? sse.accept(accept) : accept;
    const options = sse ? sse.options : { timing };
    let result;
    try {
      result = await client.chat({ ...request, doc: builder.build(), conversationId: continuation?.conversationId }, signal, accepted, sse?.onProgress, options);
    } catch (error) {
      // Linear rejected the message input before accepting it: resend the same content once
      // as a single plain paragraph in case its API does not take code blocks.
      if (sent || !error.invalidInput || format !== 'rich') throw error;
      format = 'plain';
      result = await client.chat({ ...request, doc: buildDocument().build(), conversationId: continuation?.conversationId }, signal, accepted, sse?.onProgress, options);
      promptFormatState.richRejected = true;
    }
    const firstResult = result;
    const internal = [...(result.linearToolCalls ?? [])];
    const parse = (reply, expected, raw = null) => {
      if (!raw?.trim() && !reply.text?.trim() && !reply.markdown?.trim()) return { content: null, toolCalls: [], droppedCalls: [], problems: ['The reply was empty. Answer the latest message.'] };
      // The model's raw text (when realtime carried and verified it) is parsed first.
      return parseToolReply([raw, reply.text, reply.markdown], { tools, choice, parallel, nonce: expected });
    };
    let parsed = parse(result, nonce, live?.rawAnswer(result, result.turn));
    const firstContent = parsed.content;
    let repairs = 0;
    while (parsed.problems.length && repairs < settings.toolRepairAttempts) {
      repairs++;
      nonce = newNonce();
      const repair = repairDocument({ problems: parsed.problems, nonce, choice, parallel, format });  // same format as the accepted message
      result = await client.chat({ ...request, doc: repair.build(), conversationId: result.conversationId }, signal);
      internal.push(...(result.linearToolCalls ?? []));
      parsed = parse(result, nonce);
    }
    if (parsed.problems.length) throw new GatewayError(502, 'tool_call_invalid', 'Linear Agent did not produce a valid client tool call, so nothing was sent to the client to execute. ' + parsed.problems.slice(0, 6).join(' ').slice(0, 1500));
    const toolCalls = toOpenAiToolCalls(parsed.toolCalls);
    // After a repair, keep the first reply's text when the repair has none or when it
    // cannot follow the text the client already received.
    let content = repairs && (!parsed.content || (live?.emitted && !live.extends(parsed.content))) ? firstContent : parsed.content;
    if (!toolCalls.length) {
      const cloud = internal.filter(name => LINEAR_CLOUD_WORK_TOOLS.has(name));
      const fileTools = tools.some(t => FILE_CHANGE_TOOL.test(t.name));
      if (cloud.length && (fileTools || FILE_HINT.test(content ?? ''))) content = appendNotice(content, cloudNotice(cloud));
      else if (content && choice.mode !== 'none' && CLAIM.test(content) && FILE_HINT.test(content) && fileTools && !historyHasFileChanges(input.messages)) content = appendNotice(content, CLAIM_NOTICE);
    }
    let streamed = null;
    if (live) {
      // Text before the tool block may already be on the wire; never resend or contradict it.
      const prefix = live.emitted;
      streamed = { prefix, rest: live.finish(content ?? '') };
      content = live.emitted || null;
    }
    const final = {
      tool_protocol: { upstream_turns: repairs + 1, repair_attempts: repairs, tool_calls: toolCalls.length, dropped_tool_calls: parsed.droppedCalls.length },
      ...(internal.length ? { linear_internal_tool_calls: internal } : {}),
      ...(live ? { streaming: streamingReport(live, firstResult) } : {}),
    };
    const finish = toolCalls.length ? 'tool_calls' : 'stop';
    return {
      result,
      response: { content, toolCalls, selection, final, protocolSent: includeProtocol && tools.length > 0 && choice.mode !== 'none', droppedCalls: parsed.droppedCalls.map(c => ({ name: c.name, arguments: c.arguments })) },
      send() {
        if (signal.aborted || res.destroyed) return;
        if (stream) {
          const rest = streamed ? streamed.rest : content ?? '';
          if (rest) { timing.mark('first_text'); stream.content(rest); }
          if (toolCalls.length) { timing.mark('first_tool_call'); stream.toolCalls(toolCalls); }
          timing.mark('finish');
          stream.finish(finish, { ...final, timings: timing.snapshot() }, input.includeUsage);
        } else {
          if (content) timing.mark('first_text');
          if (toolCalls.length) timing.mark('first_tool_call');
          timing.mark('finish');
          json(res, 200, { id: ids.id, object: 'chat.completion', created: ids.created, model: MODEL, ...selection, ...final, timings: timing.snapshot(), choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage: null, conversation_id: result.conversationId });
        }
      },
    };
  }
}

export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}

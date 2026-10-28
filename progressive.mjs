// Emits only text that Linear has already produced and that cannot change any more.
// While a turn is running, the last block of the last answer part may still grow,
// so it is held back; separators are sent together with the block that follows them.
// If Linear only publishes the reply at the end, the whole reply arrives in one chunk.

import { answerParts, answerText, startsLikeHtmlDocument } from './upstream.mjs';
import { GatewayError } from './errors.mjs';

function stableView(parts, { stopAtCode }) {
  const answer = answerParts(parts);
  const view = [];
  for (let index = 0; index < answer.length; index++) {
    const part = answer[index];
    const doc = part.bodyData;
    const blocks = Array.isArray(doc?.content) ? doc.content : [];
    const ended = index < answer.length - 1 || Boolean(part.metadata?.endedAt);
    if (startsLikeHtmlDocument(doc) && !ended) break; // final rendering re-sources the whole HTML document
    let count = ended ? blocks.length : Math.max(0, blocks.length - 1);
    let stop = false;
    if (stopAtCode) {
      // Hold back code and anything that looks like a protocol attempt, so raw tool-call
      // JSON is never shown as text even when the model forgot the code fence.
      const code = blocks.findIndex(block => block?.type === 'code_block' || /```|tool_calls|\\"nonce\\"/.test(JSON.stringify(block ?? null)));
      if (code >= 0 && code < count) { count = code; stop = true; }
    }
    if (count) view.push({ ...part, bodyData: { ...doc, content: blocks.slice(0, count) } });
    if (stop || count < blocks.length) break;
  }
  return answerText(view);
}

export class ProgressiveText {
  constructor({ stopAtCode = false } = {}) {
    this.stopAtCode = stopAtCode;
    this.emitted = '';
    this.progressiveChunks = 0;
    this.frozen = false;
    this.divergent = false;
  }
  /** Text that became stable since the previous call (empty string if none). */
  update(parts) {
    if (this.frozen) return '';
    const candidate = stableView(parts, { stopAtCode: this.stopAtCode });
    if (!candidate.startsWith(this.emitted)) {
      this.divergent = true;
      throw new GatewayError(502, 'linear_stream_rewritten', 'Linear rewrote already streamed text. Discard this partial reply and use buffered streaming.');
    }
    if (candidate.length === this.emitted.length) return '';
    const delta = candidate.slice(this.emitted.length);
    this.emitted = candidate;
    this.progressiveChunks++;
    return delta;
  }
  /** The rest of the final text. Never repeats emitted text unless Linear rewrote it. */
  finish(finalText) {
    const text = finalText ?? '';
    if (text.startsWith(this.emitted)) {
      const rest = text.slice(this.emitted.length);
      this.emitted = text;
      return rest;
    }
    // SSE cannot retract a prefix: fail explicitly instead of duplicating or hiding text.
    this.divergent = true;
    throw new GatewayError(502, 'linear_stream_rewritten', 'Linear rewrote already streamed text. Discard this partial reply and use buffered streaming.');
  }
}

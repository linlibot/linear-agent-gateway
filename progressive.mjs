// Emits only text that Linear has already produced and that cannot change any more.
// While a turn is running, the last block of the last answer part may still grow,
// so it is held back; separators are sent together with the block that follows them.
// If Linear only publishes the reply at the end, the whole reply arrives in one chunk.
//
// LiveText adds the realtime channel as a second source. Exactly one source owns a
// response: the first one that puts text on the wire. Realtime text is the model's
// raw Markdown as it arrives, minus what may still change meaning: trailing
// whitespace, a split surrogate pair, the first characters of a part until it is
// clear whether it starts an HTML document (sent inside an html fence, like the
// final rendering), and in tool mode everything from the first line that could
// belong to the tool protocol (fences, JSON, nonce). At the end the realtime text
// of each part must match Linear's final snapshot; the remainder is then spliced
// onto what was sent, or the stream fails explicitly if they disagree.

import { answerParts, answerText, renderAnswerPart, startsLikeHtmlDocument } from './upstream.mjs';
import { GatewayError } from './errors.mjs';
import { sameContent, spliceRest } from './consistency.mjs';

const rewritten = () => new GatewayError(502, 'linear_stream_rewritten', 'Linear rewrote already streamed text. Discard this partial reply and use buffered streaming.');

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
    throw rewritten();
  }
}

const HTML_STARTS = ['<!doctype html', '<html'];
const PROTOCOL_LINE = /`{3}|~{3}|tool_calls|"nonce"|\blgw-[a-z0-9]/i;
const JSON_LINE = /^\s*[[{]/;
const HTML_LINE = /^\s*(?:<!doctype html\b|<html\b)/i;

/** 'html' or 'text' once the start of a part decides it, null while it could still be either. */
export function htmlStart(body) {
  const head = body.slice(0, 16).toLowerCase();
  if (!head) return null;
  for (const pattern of HTML_STARTS) {
    if (head.length <= pattern.length) { if (pattern.startsWith(head)) return null; }
    else if (head.startsWith(pattern) && !/\w/.test(head[pattern.length])) return 'html';
  }
  return 'text';
}

/** Drops trailing whitespace and a dangling high surrogate: both may still change. */
export function holdTrailing(text) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

const fenceFor = text => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));

/**
 * What of one realtime part may be shown. `final` means the part will not grow.
 * Chat mode streams raw Markdown; a part that starts an HTML document is wrapped in
 * an html fence (it would otherwise be rendered as Markdown). Tool mode streams
 * complete lines only and stops for good at the first protocol-like line.
 */
export function liveForm(part, { stopAtCode = false, final = false } = {}) {
  const body = String(part.raw ?? '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
  if (stopAtCode) {
    const lines = (final ? body : body.slice(0, body.lastIndexOf('\n') + 1)).split('\n');
    if (!final) lines.pop();
    const kept = [];
    let frozen = false;
    for (const line of lines) {
      if (PROTOCOL_LINE.test(line) || JSON_LINE.test(line) || (!kept.some(l => l.trim()) && HTML_LINE.test(line))) { frozen = true; break; }
      kept.push(line);
    }
    return { text: holdTrailing(kept.join('\n')), frozen };
  }
  const start = htmlStart(body);
  if (start === null && !final) return { text: '', held: true };
  if (start === 'html') {
    const run = body.search(/`{3,}/);
    if (final) return { text: '```html\n' + body.replace(/\s+$/, '') + '\n```', fenceConflict: run >= 0 };
    return { text: '```html\n' + holdTrailing(run >= 0 ? body.slice(0, run) : body), frozen: run >= 0 };
  }
  // A lone list/heading marker may change presentation in the final rendering.
  // Hold it until its content arrives so a disconnect cannot leave a dangling marker.
  const marker = !final && body.match(/(?:^|\n)[ \t]*(?:[-*+]|#{1,6}|\d{1,9}[.)])[ \t]*$/);
  return { text: final ? body.replace(/\s+$/, '') : holdTrailing(marker ? body.slice(0, marker.index) : body) };
}

function docFeatures(node, found = { nodes: new Set(), marks: new Set() }) {
  if (!node || typeof node !== 'object') return found;
  if (typeof node.type === 'string') found.nodes.add(node.type);
  for (const mark of node.marks ?? []) if (typeof mark?.type === 'string') found.marks.add(mark.type);
  for (const child of Array.isArray(node.content) ? node.content : []) docFeatures(child, found);
  return found;
}

/** True when the final document has structure whose Markdown syntax the realtime text lacks. */
export function plainDeltas(doc, raw) {
  const { nodes, marks } = docFeatures(doc);
  if (nodes.has('code_block') && !/^ {0,3}(?:`{3,}|~{3,})|^ {4}|^\t/m.test(raw)) return true;
  if (nodes.has('heading') && !/^ {0,3}#{1,6}(?:\s|$)|\n {0,3}(?:=+|-+)\s*$/m.test(raw)) return true;
  if ((nodes.has('bullet_list') || nodes.has('ordered_list')) && !/^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/m.test(raw)) return true;
  if (['strong', 'bold', 'em', 'italic'].some(type => marks.has(type)) && !/[*_]/.test(raw)) return true;
  if (marks.has('code') && !raw.includes('`')) return true;
  return false;
}

/**
 * How the realtime text of a part matches Linear's final part: 'exact' (same as the
 * Markdown body), 'body'/'rich' (same words as the body or the rich-text rendering),
 * 'normalized' (same apart from mention/emoji tokens), or null.
 */
export function verifyPart(part, final) {
  const raw = String(part.raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return null;
  const body = typeof final.body === 'string' ? final.body.replace(/\r\n?/g, '\n').trim() : null;
  if (body !== null && body === raw) return 'exact';
  // The syntax heuristic is for Markdown; an HTML document is compared by content only.
  if (htmlStart(raw) !== 'html' && plainDeltas(final.bodyData, raw)) return null;
  const form = liveForm(part, { final: true }).text;
  const sources = [...new Set([raw, form])];
  const finals = [...(body !== null ? [['body', body]] : []), ['rich', renderAnswerPart(final)]];
  for (const [label, text] of finals) if (sources.some(source => sameContent(source, text) === 'skeleton')) return label;
  for (const [, text] of finals) if (sources.some(source => sameContent(source, text))) return 'normalized';
  return null;
}

function realtimePartFor(final, turn, finals) {
  const live = turn.answerParts();
  return turn.parts.get(final.id) ?? (finals.length === 1 && live.length === 1 ? live[0] : null);
}

export class LiveText {
  constructor({ stopAtCode = false } = {}) {
    this.stopAtCode = stopAtCode;
    this.progressive = new ProgressiveText({ stopAtCode });
    this.emitted = '';
    this.source = null;
    this.chunks = 0;
    this.frozen = null;
    this.divergent = false;
    this.checks = [];
    this.spliced = false;
  }
  get progressiveChunks() { return this.chunks; }
  emit(text, source) {
    const delta = text.slice(this.emitted.length);
    if (!delta) return '';
    this.emitted = text;
    this.source = source;
    this.chunks++;
    return delta;
  }
  /** Stable text from a GraphQL poll, unless realtime text is already on the wire. */
  fromPolls(parts) {
    if (this.source === 'realtime') return '';
    const delta = this.progressive.update(parts);
    return delta ? this.emit(this.progressive.emitted, 'polling') : '';
  }
  /** New realtime text that can be shown; never throws, stops instead. */
  fromRealtime(turn) {
    if (this.source === 'polling' || this.frozen || !turn) return '';
    if (turn.diverged) { this.frozen = turn.diverged; return ''; }
    let text = '';
    for (const part of turn.sequence()) {
      if (part.ours === undefined) break;
      if (!part.ours || part.phase !== 'answer') continue;
      if (!part.anchored) break;
      const form = liveForm(part, { stopAtCode: this.stopAtCode, final: part.closed });
      if (form.text) text += (text ? '\n\n' : '') + form.text;
      if (form.frozen) { this.frozen = this.stopAtCode ? 'tool_protocol' : 'fence_conflict'; break; }
      if (form.held || !part.closed) break;
    }
    if (!text.startsWith(this.emitted)) { this.frozen = 'non_monotonic'; return ''; }
    return this.emit(text, 'realtime');
  }
  /**
   * Final answer text for chat mode: the realtime text of every part it verifiably
   * carried, Linear's rendering for the others. Unchanged when realtime sent nothing.
   */
  compose(result, turn) {
    if (this.source !== 'realtime' || !turn) return result.text;
    const finals = result.parts ?? [];
    const forms = finals.map(final => {
      const part = realtimePartFor(final, turn, finals);
      const check = part?.anchored ? verifyPart(part, final) : null;
      this.checks.push(check ?? 'unverified');
      return check ? liveForm(part, { final: true }).text : renderAnswerPart(final);
    });
    return forms.filter(Boolean).join('\n\n');
  }
  /** The model's raw text for tool parsing, when realtime verifiably carried every part. */
  rawAnswer(result, turn) {
    if (this.source !== 'realtime' || !turn) return null;
    const finals = result.parts ?? [];
    const forms = [];
    for (const final of finals) {
      const part = realtimePartFor(final, turn, finals);
      const check = part?.anchored ? verifyPart(part, final) : null;
      this.checks.push(check ?? 'unverified');
      if (!check) return null;
      if (!this.stopAtCode) { forms.push(liveForm(part, { final: true }).text); continue; }
      const raw = String(part.raw).replace(/\r\n?/g, '\n').trim();
      // Same rule as the polling rendering: only a complete HTML document is fenced.
      forms.push(HTML_LINE.test(raw) && /<\/html>\s*$/i.test(raw) ? `${fenceFor(raw)}html\n${raw}\n${fenceFor(raw)}` : raw);
    }
    return forms.filter(Boolean).join('\n\n');
  }
  /** The rest of the final text. Never repeats or contradicts what was already sent. */
  finish(finalText) {
    const text = finalText ?? '';
    if (this.source === 'polling') {
      try { return this.progressive.finish(text); }
      catch (error) { this.divergent = true; throw error; }
      finally { this.emitted = this.progressive.emitted; }
    }
    const rest = spliceRest(this.emitted, text);
    if (rest === null) { this.divergent = true; throw rewritten(); }
    if (!text.startsWith(this.emitted)) this.spliced = true;
    this.emitted += rest;
    return rest;
  }
  /** Whether an alternative final text can follow what was sent (used after tool repairs). */
  extends(text) { return spliceRest(this.emitted, text ?? '') !== null; }
  report() {
    return {
      progressive_chunks: this.chunks,
      rewritten: this.divergent,
      source: this.source ?? 'final',
      ...(this.frozen ? { realtime_stopped: this.frozen } : {}),
      ...(this.checks.length ? { consistency: this.spliced ? 'spliced' : this.checks.join(',') } : this.spliced ? { consistency: 'spliced' } : {}),
    };
  }
}

// Content checks between text that was already streamed and Linear's final reply.
//
// The letter-only skeleton is used to recognize the beginning of a live part.
// Final equality and prefix splicing use the stricter normalizer below: code,
// punctuation, operators, link destinations and identifiers remain significant.

const ENTITY = /&(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});/gi;
const DESTINATION = /\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\)/g;
// Tokens Linear may turn into mention or emoji nodes whose visible label differs.
const MENTION = /(?<![\w@])@[\w.-]{1,64}|(?<!\w):[a-z0-9_+-]{1,40}:(?!\w)|\b[A-Z][A-Z0-9]{0,9}-\d{1,7}\b/g;
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const LETTER = /[\p{L}\p{N}]/u;

function removedRanges(line, { prose, tolerant }) {
  const ranges = [];
  const add = (start, end) => { if (end > start) ranges.push([start, end]); };
  for (const match of line.matchAll(ENTITY)) add(match.index, match.index + match[0].length);
  if (!prose) return ranges;
  const marker = line.match(/^((?:\s*>)*\s*)((?:[-*+]|\d{1,9}[.)])\s+)?(\[[ xX]\]\s+)?/);
  if (marker) add(marker[1].length, marker[0].length);
  for (const match of line.matchAll(DESTINATION)) add(match.index + 1, match.index + match[0].length);
  if (tolerant) for (const match of line.matchAll(MENTION)) add(match.index, match.index + match[0].length);
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Letters and digits of a Markdown string, with `map[i]` giving the source index of
 * the i-th kept code point. `tolerant` also ignores mention, emoji and issue tokens.
 */
export function contentSkeleton(source, { tolerant = false } = {}) {
  const text = String(source ?? '');
  const kept = [];
  const map = [];
  let fence = null, offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (fence) {
      const close = line.match(CLOSE_FENCE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) { fence = null; continue; }
    } else {
      const open = line.match(OPEN_FENCE);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = { char: open[1][0], size: open[1].length }; continue; }
    }
    const ranges = removedRanges(line, { prose: !fence, tolerant });
    let next = 0;
    for (let i = 0; i < line.length;) {
      const code = line.codePointAt(i);
      const width = code > 0xffff ? 2 : 1;
      while (next < ranges.length && ranges[next][1] <= i) next++;
      const removed = next < ranges.length && ranges[next][0] <= i;
      const char = String.fromCodePoint(code);
      if (!removed && LETTER.test(char)) { kept.push(char); map.push(start + i); }
      i += width;
    }
  }
  return { text: kept.join(''), map, count: map.length };
}

export const skeleton = (text, options) => contentSkeleton(text, options).text;

// The letter-only skeleton above is an anchoring heuristic, never proof of final
// equality. Operators, punctuation, whitespace in code, link destinations and
// mention/issue IDs can change meaning and must survive the final comparison.
function normalizedContent(source) {
  const original = String(source ?? '');
  const units = [...original.matchAll(/[^\r\n]*?(?:\r\n|\r|\n|$)/g)].filter(m => m[0]);
  const chars = [], map = [];
  const append = (value, index) => { for (let i = 0; i < value.length; i++) { chars.push(value[i]); map.push(index); } };
  let fence = null;
  // A bare HTML document and its protective html fence carry the same source.
  const html = /^\s*(?:```html\s*\r?\n)?\s*(?:<!doctype html\b|<html\b)/i.test(original);
  for (const match of units) {
    const full = match[0], line = full.replace(/[\r\n]+$/, ''), start = match.index;
    const ending = full.slice(line.length);
    if (fence) {
      const close = line.match(CLOSE_FENCE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) { if (!html) append('\u0000end\u0000', start); fence = null; continue; }
    } else {
      const open = line.match(OPEN_FENCE);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) { if (!html) append('\u0000code\u0000', start); fence = { char: open[1][0], size: open[1].length }; continue; }
    }
    const literal = Boolean(fence) || html;
    const skip = new Set(), markers = new Map();
    const remove = (from, to) => { for (let i = from; i < to; i++) skip.add(i); };
    if (!literal) {
      const marker = line.match(/^(?:\s*>\s*)*(?: {0,3}#{1,6}\s+|\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)/);
      if (marker) remove(0, marker[0].length);
      // Only paired, word-bounded emphasis is formatting. Inline code is literal.
      const code = [...line.matchAll(/(`+)([^`]*?)\1/g)];
      const inCode = index => code.some(m => index >= m.index && index < m.index + m[0].length);
      for (const m of code) {
        const close = m.index + m[0].length - m[1].length;
        remove(m.index, m.index + m[1].length); remove(close, m.index + m[0].length);
        markers.set(m.index, '\u0000inline\u0000'); markers.set(close, '\u0000endinline\u0000');
      }
      const emphasis = /(?<![\p{L}\p{N}\\])([*_]{1,2})(?=\S)(.+?\S|\S)\1(?![\p{L}\p{N}])/gu;
      for (const m of line.matchAll(emphasis)) if (!inCode(m.index)) { remove(m.index, m.index + m[1].length); remove(m.index + m[0].length - m[1].length, m.index + m[0].length); }
      for (let i = 0; i < line.length; i++) {
        if (markers.has(i)) append(markers.get(i), start + i);
        if (skip.has(i)) continue;
        if (!inCode(i) && /\s/.test(line[i])) { if (chars.length && chars.at(-1) !== ' ') append(' ', start + i); }
        else append(line[i], start + i);
      }
      if (ending && chars.length && chars.at(-1) !== ' ') append(' ', start + line.length);
    } else {
      for (let i = 0; i < line.length; i++) append(line[i], start + i);
      if (ending) append('\n', start + line.length);
    }
  }
  let begin = 0, end = chars.length;
  while (end > begin && /\s/.test(chars[end - 1])) end--;
  while (begin < end && /\s/.test(chars[begin])) begin++;
  return { text: chars.slice(begin, end).join(''), map: map.slice(begin, end) };
}

/** Final equality allows Markdown presentation changes, never semantic character changes. */
export function sameContent(a, b) {
  if (normalizedContent(a).text === normalizedContent(b).text) return 'skeleton';
  return null;
}

// Linear may parse a bare HTML document as Markdown, changing indentation and
// rendering autolinked URLs as [url](url). Compare that rendering without ever
// using its mangled source as the answer. Reject whitespace-sensitive documents
// and preserve all quoted strings, except SVG path data where indentation between
// existing lines is insignificant. This is intentionally narrower than generic
// whitespace-insensitive equality: an actual code or string edit must still fail.
export function htmlRichEquivalent(raw, rendered) {
  const unwrap = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s*```html[ \t]*\n/i, '').replace(/\n```\s*$/, '').trim();
  const original = unwrap(raw);
  const final = unwrap(rendered).replace(/\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, label, target) => label === target ? label : match);
  if (!/^(?:<!doctype html\b|<html\b)/i.test(original) || !/<\/html>\s*$/i.test(original)) return false;
  if (!/^(?:<!doctype html\b|<html\b)/i.test(final) || !/<\/html>\s*$/i.test(final)) return false;
  if (/<(?:pre|textarea|xmp|plaintext)\b|\bwhite-space\s*:\s*(?:pre|break-spaces)/i.test(original + final)) return false;
  const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  if (lines(original) !== lines(final)) return false;
  const strings = text => {
    const values = [];
    let quote = null, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch !== quote) continue;
        let value = text.slice(start, i + 1);
        const lt = text.lastIndexOf('<', start), gt = text.lastIndexOf('>', start);
        const tag = text.slice(lt, start), before = text.slice(Math.max(0, start - 120), start);
        const pathAttribute = lt > gt && /^<path\b/i.test(tag) && /\bd\s*=\s*$/i.test(tag);
        const pathTemplate = quote === '`' && /\.setAttribute\(\s*["']d["']\s*,\s*$/i.test(before) && !/\$\{[^}]*\n/.test(value);
        if (pathAttribute || pathTemplate) value = value.split('\n').map(line => line.trim()).join('\n');
        values.push(value);
        quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') { quote = ch; start = i; }
    }
    return quote ? null : values;
  };
  const a = strings(original), b = strings(final);
  if (!a || !b || a.length !== b.length || a.some((value, i) => value !== b[i])) return false;
  // Preserve visible text and the presence of whitespace between elements:
  // removing an inter-tag space can change how inline elements are displayed.
  const visible = text => text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').split(/<[^>]*>/);
  const va = visible(original), vb = visible(final);
  return va.length === vb.length && va.every((value, i) => value.trim() || vb[i].trim() ? value === vb[i] : Boolean(value) === Boolean(vb[i]));
}

/**
 * The part of `finalText` that follows an already streamed prefix, or null when
 * the prefix is not consistent with it. A plain string prefix is used directly;
 * otherwise the split point is found by aligning the two skeletons, so a prefix
 * streamed in raw Markdown can be continued with Linear's normalized rendering
 * without repeating or dropping words.
 */
export function spliceRest(emitted, finalText) {
  const prefix = String(emitted ?? ''), whole = String(finalText ?? '');
  if (whole.startsWith(prefix)) return whole.slice(prefix.length);
  const e = normalizedContent(prefix), f = normalizedContent(whole);
  if (!e.text || !f.text.startsWith(e.text)) return null;
  const position = f.map[e.text.length] ?? whole.length;
  const rest = whole.slice(position);
  return sameContent(prefix + rest, whole) ? rest : null;
}

// Builds Linear (ProseMirror) message documents and scans Markdown code fences.
//
// Client-supplied text (system prompts, file contents, tool results) is placed in
// code_block nodes so that Linear's Markdown conversion cannot escape, re-wrap or
// re-format it. Gateway instructions use plain paragraphs.

export const PROMPT_FORMATS = ['rich', 'plain'];

/** The original single-paragraph format used for plain chat requests. */
export function textDoc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function fenceFor(text, minimum = 3) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

function inline(text) {
  const nodes = [];
  String(text).split('\n').forEach((line, index) => {
    if (index) nodes.push({ type: 'hard_break' });
    if (line) nodes.push({ type: 'text', text: line });
  });
  while (nodes.length && nodes.at(-1).type === 'hard_break') nodes.pop();
  return nodes;
}

export class DocBuilder {
  constructor(format = 'rich') {
    if (!PROMPT_FORMATS.includes(format)) throw new Error('Unknown prompt format');
    this.format = format;
    this.blocks = [];
  }
  heading(text, level = 3) { this.blocks.push({ kind: 'heading', text: String(text), level }); return this; }
  paragraph(text) { if (String(text).trim()) this.blocks.push({ kind: 'paragraph', text: String(text) }); return this; }
  code(text, language = 'text') { this.blocks.push({ kind: 'code', text: String(text ?? ''), language }); return this; }
  /** Markdown rendering of the document, used for the plain format and size checks. */
  markdown() {
    return this.blocks.map(block => {
      if (block.kind === 'heading') return '#'.repeat(block.level) + ' ' + block.text;
      if (block.kind === 'paragraph') return block.text;
      const fence = fenceFor(block.text);
      return `${fence}${block.language}\n${block.text}\n${fence}`;
    }).join('\n\n');
  }
  build() {
    if (this.format === 'plain') return textDoc(this.markdown());
    const content = this.blocks.map(block => {
      if (block.kind === 'heading') return { type: 'heading', attrs: { level: block.level }, content: inline(block.text) };
      if (block.kind === 'paragraph') return { type: 'paragraph', content: inline(block.text) };
      return { type: 'code_block', attrs: { language: block.language }, ...(block.text ? { content: [{ type: 'text', text: block.text }] } : {}) };
    }).filter(node => node.type === 'code_block' || node.content.length);
    return { type: 'doc', content };
  }
  get length() { return this.markdown().length; }
}

/**
 * Finds fenced code blocks in Markdown (CommonMark rules for fence opening and
 * closing lines). Returns { info, content, start, end, closed } with character
 * offsets into the source; unterminated fences run to the end of the text.
 */
export function scanFences(markdown) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let offset = 0, open = null;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!open) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!match || (match[1][0] === '`' && match[2].includes('`'))) continue;
      open = { char: match[1][0], size: match[1].length, info: match[2].trim(), start: lineStart, bodyStart: offset, lines: [] };
      continue;
    }
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.char && close[1].length >= open.size) {
      blocks.push({ info: open.info, content: open.lines.join('\n'), start: open.start, end: Math.min(offset, text.length), closed: true });
      open = null;
    } else open.lines.push(line);
  }
  if (open) blocks.push({ info: open.info, content: open.lines.join('\n'), start: open.start, end: text.length, closed: false });
  return blocks.map(block => ({ ...block, source: text }));
}

// Client tool calling for an upstream that cannot accept function definitions.
//
// Linear's AiConversation API only runs Linear's own built-in tools (the
// AiConversationToolCall union is closed), so client tools are described to the
// Linear Agent as text and its reply must contain a strict, fenced JSON block.
// Only blocks that carry the per-reply nonce, name a declared tool and pass that
// tool's JSON Schema become OpenAI tool_calls; everything else stays text or is
// reported as a protocol problem. Nothing here executes a tool.

import { randomBytes } from 'node:crypto';
import { GatewayError } from './errors.mjs';
import { compileSchema, schemaProblems, stableStringify } from './json-schema.mjs';
import { scanFences } from './rich-doc.mjs';

export const TOOL_BLOCK_INFO = 'tool_calls';
export const MAX_TOOLS = 256;
export const MAX_CALLS_PER_REPLY = 64;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidTools = message => new GatewayError(400, 'invalid_tools', message);
const invalidChoice = message => new GatewayError(400, 'invalid_tool_choice', message);
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const newNonce = () => 'lgw-' + randomBytes(18).toString('hex');
export const newToolCallId = () => 'call_' + [...randomBytes(24)].map(b => ID_ALPHABET[b % 62]).join('');

export function normalizeTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw invalidTools(`tools must be an array; received ${typeof tools}.`);
  if (tools.length > MAX_TOOLS) throw invalidTools(`tools contains ${tools.length} definitions; the maximum is ${MAX_TOOLS}.`);
  const names = new Set();
  let size = 0;
  return tools.map((tool, index) => {
    if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) throw invalidTools(`tools[${index}] must be {"type":"function","function":{...}}. Custom and built-in tool types are not supported.`);
    const { name, description, parameters, strict } = tool.function;
    if (typeof name !== 'string' || !NAME.test(name)) throw invalidTools(`tools[${index}].function.name must match ^[a-zA-Z0-9_-]{1,64}$.`);
    if (names.has(name)) throw invalidTools(`Duplicate tool name: ${name}.`);
    names.add(name);
    if (description !== undefined && description !== null && typeof description !== 'string') throw invalidTools(`tools[${index}].function.description must be a string.`);
    if (strict !== undefined && strict !== null && typeof strict !== 'boolean') throw invalidTools(`tools[${index}].function.strict must be a boolean.`);
    const schema = parameters === undefined || parameters === null ? { type: 'object', properties: {} } : parameters;
    if (!isObject(schema)) throw invalidTools(`tools[${index}].function.parameters must be a JSON Schema object.`);
    if (schema.type !== undefined && schema.type !== 'object') throw invalidTools(`tools[${index}].function.parameters must describe an object (type "object").`);
    const problems = schemaProblems(schema);
    if (problems.length) throw invalidTools(`tools[${index}].function.parameters is not a usable JSON Schema: ${problems.slice(0, 3).join('; ')}`);
    size += JSON.stringify(tool.function).length;
    if (size > 2_000_000) throw invalidTools('Tool definitions exceed 2,000,000 characters.');
    return { name, description: description ?? '', parameters: schema, strict: strict === true, validate: compileSchema(schema) };
  });
}

/** Returns { mode: 'auto'|'none'|'required', allowed: string[], forced: string|null }. */
export function normalizeToolChoice(choice, tools) {
  const names = tools.map(t => t.name);
  if (choice === undefined || choice === null) return { mode: names.length ? 'auto' : 'none', allowed: names, forced: null };
  if (choice === 'auto' || choice === 'none') return { mode: names.length ? choice : 'none', allowed: names, forced: null };
  if (choice === 'required') {
    if (!names.length) throw invalidChoice('tool_choice "required" needs at least one tool in tools.');
    return { mode: 'required', allowed: names, forced: null };
  }
  if (isObject(choice) && choice.type === 'function') {
    const name = choice.function?.name ?? choice.name;
    if (typeof name !== 'string' || !names.includes(name)) throw invalidChoice('tool_choice names a function that is not in tools.');
    return { mode: 'required', allowed: [name], forced: name, restricted: true };
  }
  if (isObject(choice) && choice.type === 'allowed_tools' && isObject(choice.allowed_tools)) {
    const { mode = 'auto', tools: subset } = choice.allowed_tools;
    if (!['auto', 'required'].includes(mode) || !Array.isArray(subset) || !subset.length) throw invalidChoice('allowed_tools needs mode auto/required and a non-empty tools list.');
    const allowed = subset.map(t => t?.function?.name ?? t?.name);
    if (allowed.some(name => !names.includes(name))) throw invalidChoice('allowed_tools names a function that is not in tools.');
    return { mode, allowed: [...new Set(allowed)], forced: null, restricted: true };
  }
  throw invalidChoice('tool_choice must be "auto", "none", "required", {"type":"function","function":{"name":...}} or an allowed_tools object.');
}

export function toolsFingerprint(tools) {
  return stableStringify(tools.map(t => [t.name, t.description, t.parameters, t.strict]));
}

function catalog(tools) {
  return JSON.stringify(tools.map(t => ({ name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters })));
}

function choiceSentence(choice) {
  if (choice.mode === 'none') return 'Client tools are disabled for this reply: answer in plain text only and do not output a tool_calls block.';
  if (choice.forced) return `You must call the client tool "${choice.forced}" in this reply, and no other tool.`;
  const subset = choice.restricted ? `You may only call these client tools in this reply: ${choice.allowed.join(', ')}. ` : '';
  return subset + (choice.mode === 'required' ? 'You must call at least one client tool in this reply.' : 'Call client tools only when they are needed; otherwise answer in text.');
}

/** Adds the protocol description and tool catalog. */
export function addProtocol(builder, { tools, choice, parallel }) {
  builder.heading('Gateway protocol for client tools');
  builder.paragraph('You are answering through an OpenAI-compatible API. The caller is an application running on the user\'s own computer, for example a coding assistant. That application owns the client tools listed below and runs them on the user\'s machine, usually after the user approves each action. You cannot see or change the user\'s computer yourself: calling one of these client tools is the only way to read, create or modify the user\'s local files, run commands there, or take any other action on their machine.');
  builder.paragraph('Do not use your own built-in Linear tools for this conversation (sandboxes, Bash, code mode, coding sessions, file reading, web search, or creating or updating issues, projects or documents). Their files and paths live in Linear\'s cloud, not on the user\'s computer, and the application never sees their results.');
  builder.paragraph('To call client tools, end your reply with exactly one fenced code block whose info string is tool_calls. It contains one JSON object with the nonce given in the latest message and a non-empty tool_calls array:');
  builder.code(JSON.stringify({ nonce: '<nonce from the latest message>', tool_calls: [{ name: '<client tool name>', arguments: { path: 'C:\\project\\notes.txt', text: 'first line\nsecond line' } }] }), TOOL_BLOCK_INFO);
  builder.paragraph([
    'Rules:',
    '1. Every name must be one of the client tool names below, and every arguments value must be a JSON object that satisfies that tool\'s JSON Schema: include all required parameters and no parameters the schema does not allow. The arguments in the example only show the format; use the parameters each tool defines.',
    '2. Write strict JSON: double quotes, no comments and no trailing commas. Inside strings, escape newlines and backslashes exactly as in the example (Windows paths need doubled backslashes).',
    parallel ? '3. You may put several independent calls in the array. The application may execute them concurrently. When a call depends on another call (such as reading a file after writing it), request the first call and wait for its result before requesting the dependent call.' : '3. Put exactly one call in the array.',
    '4. Text before the block is shown to the user. Write nothing after the block.',
    '5. After the block, stop and wait. The application sends the tool results in its next message. Never invent tool results, and never say that an action is done before you have seen its result.',
    '6. If no client tool is needed, answer normally without a tool_calls block. Never use a tool_calls block as an example or illustration.',
  ].join('\n'));
  addCatalog(builder, tools, 'Client tools');
}

export function addCatalog(builder, tools, title = 'Updated client tools') {
  builder.heading(title);
  builder.paragraph('JSON list of the tools the application provides, with their JSON Schema parameters:');
  builder.code(catalog(tools), 'json');
}

export function addFooter(builder, { nonce, choice, parallel }) {
  builder.heading('Reply now');
  const format = choice.mode === 'none' ? '' : ` To call client tools, end the reply with one \`\`\`${TOOL_BLOCK_INFO} code block containing {"nonce":"${nonce}","tool_calls":[{"name":...,"arguments":{...}}]}${parallel ? '' : ' with exactly one call'}.`;
  builder.paragraph(`Reply as the assistant to the latest message above. Nonce for this reply: ${nonce}. ${choiceSentence(choice)}${format}`);
}

export function addRepair(builder, { problems, nonce, choice, parallel }) {
  builder.heading('Previous reply could not be used');
  builder.paragraph('The gateway did not pass your previous reply to the application because of these problems:\n' + problems.map(p => '- ' + p).join('\n'));
  builder.paragraph(choice.mode === 'required'
    ? `Send the corrected reply now: only the \`\`\`${TOOL_BLOCK_INFO} block with nonce ${nonce}, without repeating earlier explanations.`
    : `Send the corrected reply now: only the \`\`\`${TOOL_BLOCK_INFO} block with nonce ${nonce}, without repeating earlier explanations. If you did not mean to call a client tool, reply with normal text and no tool_calls block.`);
  addFooter(builder, { nonce, choice, parallel });
}

function parseArguments(value, index) {
  if (value === undefined) return { value: {} };
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { problem: `tool_calls[${index}].arguments is a string that is not valid JSON; give arguments as a JSON object.` }; }
  }
  if (!isObject(value)) return { problem: `tool_calls[${index}].arguments must be a JSON object.` };
  return { value };
}

function parseOne(text, { tools, choice, parallel, nonce }) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (choice.mode === 'none') return { content: source.trim() || null, toolCalls: [], droppedCalls: [], problems: [], attempted: false };
  const candidates = [];
  for (const fence of scanFences(source)) {
    const labeled = fence.info === TOOL_BLOCK_INFO;
    let json, jsonError = null;
    try { json = JSON.parse(fence.content, (key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite JSON number.'); return value; }); } catch (error) { jsonError = error.message; }
    const shaped = isObject(json) && Object.hasOwn(json, 'tool_calls') && Object.hasOwn(json, 'nonce');
    if (labeled || shaped || fence.content.includes(nonce)) candidates.push({ fence, labeled, json, jsonError });
  }
  const problems = [];
  const required = choice.mode === 'required';
  if (!candidates.length) {
    if (source.includes(nonce)) problems.push(`The tool_calls JSON must be inside a fenced code block that starts with \`\`\`${TOOL_BLOCK_INFO} and ends with \`\`\`.`);
    else if (required) problems.push(choice.forced ? `This reply must call the client tool "${choice.forced}", but it contains no tool_calls block.` : 'This reply must call at least one client tool, but it contains no tool_calls block.');
    return { content: source.trim() || null, toolCalls: [], droppedCalls: [], problems, attempted: problems.length > 0 };
  }
  if (candidates.length > 1) problems.push('Send exactly one tool_calls block; put all calls in its tool_calls array.');
  const { fence, json, jsonError } = candidates.at(-1);
  if (!fence.closed) problems.push('The tool_calls block is not closed with ```.');
  if (source.slice(fence.end).trim()) problems.push('Do not write anything after the tool_calls block.');
  const calls = [];
  if (jsonError !== null) problems.push(`The tool_calls block is not valid JSON (${jsonError.slice(0, 160)}).`);
  else if (!isObject(json)) problems.push('The tool_calls block must contain one JSON object.');
  else {
    const extra = Object.keys(json).filter(k => k !== 'nonce' && k !== 'tool_calls');
    if (extra.length) problems.push(`Unexpected top-level fields: ${extra.join(', ')}. Use only nonce and tool_calls.`);
    if (json.nonce !== nonce) problems.push(json.nonce === undefined ? `The block is missing "nonce":"${nonce}".` : `The nonce must be "${nonce}" for this reply.`);
    if (!Array.isArray(json.tool_calls) || !json.tool_calls.length) problems.push('tool_calls must be a non-empty array. If no client tool is needed, omit the block.');
    else if (json.tool_calls.length > MAX_CALLS_PER_REPLY) problems.push(`Send at most ${MAX_CALLS_PER_REPLY} tool calls in one reply.`);
    else json.tool_calls.forEach((call, index) => {
      if (!isObject(call)) { problems.push(`tool_calls[${index}] must be an object with name and arguments.`); return; }
      const unknown = Object.keys(call).filter(k => !['name', 'arguments', 'id', 'type'].includes(k));
      if (unknown.length) problems.push(`tool_calls[${index}] has unexpected fields: ${unknown.join(', ')}.`);
      const tool = tools.find(t => t.name === call.name);
      if (!tool) { problems.push(`tool_calls[${index}].name ${JSON.stringify(call.name)} is not a client tool. Available: ${tools.map(t => t.name).join(', ').slice(0, 600)}.`); return; }
      if (!choice.allowed.includes(tool.name)) { problems.push(`tool_calls[${index}] calls "${tool.name}", which is not allowed for this reply (${choice.allowed.join(', ')}).`); return; }
      const args = parseArguments(call.arguments, index);
      if (args.problem) { problems.push(args.problem); return; }
      const result = tool.validate(args.value);
      if (!result.valid) for (const error of result.errors.slice(0, 8)) problems.push(`tool_calls[${index}] (${tool.name}) arguments ${error.path === '(root)' ? '' : error.path + ' '}${error.message}.`);
      else calls.push({ name: tool.name, arguments: args.value, argumentsJson: JSON.stringify(args.value) });
    });
  }
  const content = source.slice(0, fence.start).trim() || null;
  if (problems.length) return { content, toolCalls: [], droppedCalls: [], problems, attempted: true };
  const kept = parallel === false ? calls.slice(0, 1) : calls;
  return { content, toolCalls: kept, droppedCalls: calls.slice(kept.length), problems: [], attempted: true };
}

/**
 * Parses one reply. `sources` are alternative renderings of the same Linear
 * reply (rich text first, then Markdown). A rendering with valid calls wins;
 * otherwise a rendering with a recognisable but broken attempt is reported.
 */
export function parseToolReply(sources, options) {
  const results = sources.filter(s => typeof s === 'string').map(text => parseOne(text, options));
  return results.find(r => !r.problems.length && r.toolCalls.length)
    ?? results.find(r => r.problems.length && r.attempted)
    ?? results[0]
    ?? parseOne('', options);
}

/** Converts parsed calls into OpenAI tool_calls with fresh IDs. */
export function toOpenAiToolCalls(calls) {
  return calls.map(call => ({ id: newToolCallId(), type: 'function', function: { name: call.name, arguments: call.argumentsJson } }));
}

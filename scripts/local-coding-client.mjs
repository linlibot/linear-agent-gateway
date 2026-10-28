// A tiny local coding client that drives a tool loop through any OpenAI-compatible
// endpoint, the way Cline or Roo Code do. All tools run here, on this machine, inside
// one workspace directory; the gateway only returns tool calls.
//
// Usage (small real-quota check against your own gateway):
//   LINEAR_GATEWAY_KEY=... node scripts/local-coding-client.mjs \
//     --base https://your-gateway/v1 --model linear-agent [--workspace ./tmp-e2e] [--stream] [--task "..."]
// Without --workspace a fresh temporary directory is used and kept for inspection.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

export const DEFAULT_TASK = 'Create index.html in the workspace with the page title "Draft". Then read the file, change the title to "Final Title", and read it again to verify the change. Finish with a short summary of what changed.';

export const CODING_TOOLS = [
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a text file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace root.' }, content: { type: 'string', description: 'Complete new file content.' } }, required: ['path', 'content'], additionalProperties: false }, strict: true } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true } },
  { type: 'function', function: { name: 'replace_in_file', description: 'Replace exactly one occurrence of old_text with new_text in a workspace file (a minimal patch).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false }, strict: true } },
  { type: 'function', function: { name: 'list_files', description: 'List files in a workspace directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true } },
  { type: 'function', function: { name: 'run_command', description: 'Run a test command in the workspace. Only "node --test <file>" and "node <file>" are allowed.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false }, strict: true } },
];

function inside(workspace, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[:\0]/.test(relative)) throw new Error('Paths must be relative to the workspace.');
  const target = path.resolve(workspace, relative);
  if (target !== workspace && !target.startsWith(workspace + path.sep)) throw new Error('Path escapes the workspace.');
  return target;
}

/** Executes one tool call locally. Errors are returned to the model as tool results. */
export async function runTool(workspace, name, args) {
  // Reject symlinks/junctions on existing path components. This example is not an
  // OS sandbox: an approved JS command still has the client's process privileges.
  if (name !== 'run_command') {
    const target = inside(workspace, args.path === '' ? '.' : args.path);
    let probe = target;
    for (;;) {
      try { if ((await fs.lstat(probe)).isSymbolicLink()) throw new Error('Symlink paths are not allowed by this client.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (probe === workspace) break;
      probe = path.dirname(probe);
    }
  }
  if (name === 'write_file') {
    const target = inside(workspace, args.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, args.content);
    return `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`;
  }
  if (name === 'read_file') return await fs.readFile(inside(workspace, args.path), 'utf8');
  if (name === 'replace_in_file') {
    const target = inside(workspace, args.path);
    const text = await fs.readFile(target, 'utf8');
    const count = text.split(args.old_text).length - 1;
    if (count !== 1) throw new Error(`old_text must occur exactly once in ${args.path}; found ${count}.`);
    await fs.writeFile(target, text.replace(args.old_text, () => args.new_text));
    return `Replaced 1 occurrence in ${args.path}.`;
  }
  if (name === 'list_files') return (await fs.readdir(inside(workspace, args.path === '' ? '.' : args.path))).sort().join('\n');
  if (name === 'run_command') {
    const parts = String(args.command).trim().split(/\s+/);
    const allowed = parts[0] === 'node' && ((parts.length === 3 && parts[1] === '--test') || parts.length === 2);
    if (!allowed) throw new Error('Command not allowed by this client: ' + args.command);
    const file = inside(workspace, parts.at(-1));
    return await new Promise(resolve => execFile(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', ...parts.slice(1, -1), path.relative(workspace, file)], { cwd: workspace, timeout: 20000, env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TEMP } : {}) } }, (error, stdout, stderr) => {
      resolve(`exit code ${error ? error.code ?? 1 : 0}\n${stdout}${stderr}`.slice(0, 20000));
    }));
  }
  throw new Error('Unknown tool ' + name);
}

function parseSse(text) {
  const events = text.split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
  if (events.at(-1) !== '[DONE]') throw new Error('Stream did not end with [DONE].');
  let content = '', finish = null;
  const calls = [];
  for (const raw of events.slice(0, -1)) {
    const chunk = JSON.parse(raw);
    if (chunk.error) throw Object.assign(new Error(chunk.error.message), { code: chunk.error.code });
    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) content += choice.delta.content;
      for (const call of choice.delta?.tool_calls ?? []) {
        calls[call.index] ??= { id: call.id, type: 'function', function: { name: call.function?.name, arguments: '' } };
        calls[call.index].function.arguments += call.function?.arguments ?? '';
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return { message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish };
}

/**
 * Runs a task to completion. `approve(name, args)` mirrors the client-side permission
 * prompt of Cline/Roo Code; returning false sends a "denied" result instead of running.
 */
export async function runCodingTask({ base, key, model = 'linear-agent', workspace, task = DEFAULT_TASK, tools = CODING_TOOLS, stream = true, maxTurns = 12, approve = async () => false, fetchImpl = fetch, onEvent = () => {}, extraBody = {} }) {
  const root = path.resolve(workspace);
  const messages = [
    { role: 'system', content: [{ type: 'text', text: `You are a coding assistant working in a local workspace (${path.basename(root)}). Use the provided tools to read and change files and to run tests. Paths are relative to the workspace root.`, cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: task },
  ];
  const log = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const body = { model, messages, tools, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), temperature: 0, parallel_tool_calls: true, ...extraBody };
    const response = await fetchImpl(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Object.assign(new Error(`Gateway HTTP ${response.status}: ${await response.text()}`), { status: response.status });
    const headers = { session: response.headers.get('x-linear-tool-session'), conversation: response.headers.get('x-linear-conversation-id') };
    const { message, finish } = stream ? parseSse(await response.text()) : (data => ({ message: data.choices[0].message, finish: data.choices[0].finish_reason }))(await response.json());
    messages.push(message);
    onEvent({ type: 'assistant', turn, finish, content: message.content, tool_calls: message.tool_calls?.map(c => c.function.name) ?? [], ...headers });
    if (finish !== 'tool_calls' || !message.tool_calls?.length) {
      log.push({ turn, final: message.content, ...headers });
      return { final: message.content, messages, log, turns: turn + 1 };
    }
    for (const call of message.tool_calls) {
      let args, output;
      try { args = JSON.parse(call.function.arguments); } catch { args = null; }
      if (!args) output = 'Error: arguments were not valid JSON.';
      else if (!(await approve(call.function.name, args))) output = 'The user denied this action.';
      else {
        try { output = await runTool(root, call.function.name, args); }
        catch (error) { output = 'Error: ' + error.message; }
      }
      log.push({ turn, tool: call.function.name, args, output: output.slice(0, 300), ...headers });
      onEvent({ type: 'tool', turn, name: call.function.name, args, output });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  throw new Error(`Task did not finish within ${maxTurns} model turns.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf('--' + name); return index > 0 ? process.argv[index + 1] : undefined; };
  const base = argument('base') ?? 'http://127.0.0.1:8089/v1';
  const key = process.env.LINEAR_GATEWAY_KEY;
  if (!key) { console.error('Set LINEAR_GATEWAY_KEY to a client key created at /keys.'); process.exit(2); }
  const workspace = argument('workspace') ?? await fs.mkdtemp(path.join(os.tmpdir(), 'linear-gateway-e2e-'));
  await fs.mkdir(workspace, { recursive: true });
  console.log(JSON.stringify({ workspace: path.resolve(workspace), base, model: argument('model') ?? 'linear-agent' }));
  const started = Date.now();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let result;
  try {
    result = await runCodingTask({ base, key, model: argument('model') ?? 'linear-agent', workspace, task: argument('task') ?? DEFAULT_TASK, stream: process.argv.includes('--stream'), approve: async (name, args) => {
      console.log(JSON.stringify({ requested_local_action: name, arguments: args }));
      return /^y(?:es)?$/i.test((await terminal.question('Allow this local action? [y/N] ')).trim());
    }, onEvent: event => console.log(JSON.stringify({ ...event, output: event.output?.slice(0, 200) })) });
  } finally { terminal.close(); }
  const files = await fs.readdir(workspace);
  const index = files.includes('index.html') ? await fs.readFile(path.join(workspace, 'index.html'), 'utf8') : null;
  console.log(JSON.stringify({ finished: true, seconds: Math.round((Date.now() - started) / 1000), turns: result.turns, files, index_has_final_title: index ? /<title>\s*Final Title\s*<\/title>/i.test(index) : null, final: result.final }, null, 2));
}

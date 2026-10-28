// End-to-end: a local coding client drives a tool loop through the gateway against a
// scripted Linear upstream. Files are created only in a temporary workspace.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGateway } from '../gateway.mjs';
import { runCodingTask as runApprovedTask } from '../scripts/local-coding-client.mjs';
const runCodingTask = options => runApprovedTask({ approve: async () => true, ...options });
import { MockLinear, labelledBlocks, nonceOf, toolCallBlock } from './mock-linear.mjs';

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-e2e-workspace-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-e2e-workspace-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

/**
 * A scripted "coding model". Its step is the number of tool-call replies it has already
 * made in this conversation, counted the same way for native continuation (one Linear
 * conversation receiving deltas) and full-transcript replay (a new conversation each time).
 */
function codingModel(plan) {
  const turns = new Map();
  return ({ conversation, doc }) => {
    const blocks = labelledBlocks(doc);
    const earlier = (turns.get(conversation.id) ?? 0) + blocks.filter(b => b.label === '[assistant requested client tools]').length;
    turns.set(conversation.id, (turns.get(conversation.id) ?? 0) + 1);
    const step = plan[earlier];
    if (!step) throw new Error('script exhausted');
    const results = blocks.filter(b => b.label.startsWith('[tool result'));
    const decision = step(results.at(-1)?.code ?? '', results);
    if (typeof decision === 'string') return { markdown: decision, chunks: 2 };
    return { markdown: toolCallBlock(nonceOf(doc), decision.calls, decision.intro), chunks: 3 };
  };
}

const htmlPlan = [
  () => ({ intro: 'Creating index.html.', calls: [{ name: 'write_file', arguments: { path: 'index.html', content: '<!doctype html>\n<html>\n<head>\n  <title>Draft</title>\n</head>\n<body><h1>Hello</h1></body>\n</html>\n' } }] }),
  () => ({ calls: [{ name: 'read_file', arguments: { path: 'index.html' } }] }),
  last => { assert.match(last, /<title>Draft<\/title>/); return { intro: 'Updating the title.', calls: [{ name: 'replace_in_file', arguments: { path: 'index.html', old_text: '<title>Draft</title>', new_text: '<title>Final Title</title>' } }] }; },
  () => ({ calls: [{ name: 'read_file', arguments: { path: 'index.html' } }] }),
  last => /<title>Final Title<\/title>/.test(last) ? 'Created index.html and changed its title from "Draft" to "Final Title"; the final read confirms the new title.' : 'Verification failed: the title was not updated.',
];

async function gateway(t, model, chat = {}) {
  const upstream = new MockLinear({ model });
  const server = createGateway({ apiKey: 'test-key', timeoutMs: 10000, clientFactory: () => upstream.client(), chat });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  return { upstream, base: `http://127.0.0.1:${server.address().port}/v1` };
}

test('E2E: create index.html, read it, change the title, verify — through streaming tool calls', async t => {
  const dir = await workspace(t);
  const { upstream, base } = await gateway(t, codingModel(htmlPlan));
  const events = [];
  const result = await runCodingTask({ base, key: 'test-key', workspace: dir, stream: true, onEvent: e => events.push(e), extraBody: { max_completion_tokens: 8192 } });
  assert.equal(result.final, 'Created index.html and changed its title from "Draft" to "Final Title"; the final read confirms the new title.');
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<title>Final Title<\/title>/);
  assert(!html.includes('Draft'));
  assert.deepEqual(await fs.readdir(dir), ['index.html'], 'nothing else was written');
  assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.name), ['write_file', 'read_file', 'replace_in_file', 'read_file']);
  assert.equal(result.turns, 5);
  assert.equal(upstream.conversationCount, 1, 'the whole task used one Linear conversation');
  assert.deepEqual(events.filter(e => e.type === 'assistant').map(e => e.session), ['new', 'native', 'native', 'native', 'native']);
});

test('E2E: the same task works when every request replays the full transcript', async t => {
  const dir = await workspace(t);
  const { upstream, base } = await gateway(t, codingModel(htmlPlan), { toolContinuation: 'replay' });
  const result = await runCodingTask({ base, key: 'test-key', workspace: dir, stream: false });
  assert.match(result.final, /Final Title/);
  assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /<title>Final Title<\/title>/);
  assert.equal(upstream.conversationCount, 5);
});

test('E2E: write code and tests, run them locally, patch the bug from the failing output, rerun', async t => {
  const dir = await workspace(t);
  const plan = [
    () => ({ calls: [
      { name: 'write_file', arguments: { path: 'sum.js', content: 'export const sum = (a, b) => a - b;\n' } },
      { name: 'write_file', arguments: { path: 'sum.test.js', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\ntest('adds', () => assert.equal(sum(2, 3), 5));\n" } },
    ] }),
    () => ({ calls: [{ name: 'run_command', arguments: { command: 'node --test sum.test.js' } }] }),
    last => { assert.match(last, /exit code [1-9]/); return { intro: 'The test fails; sum subtracts. Patching.', calls: [{ name: 'replace_in_file', arguments: { path: 'sum.js', old_text: 'a - b', new_text: 'a + b' } }] }; },
    () => ({ calls: [{ name: 'run_command', arguments: { command: 'node --test sum.test.js' } }] }),
    last => /exit code 0/.test(last) ? 'Fixed sum.js (a - b → a + b); node --test now passes.' : 'Tests still fail.',
  ];
  const { upstream, base } = await gateway(t, codingModel(plan));
  const approvals = [];
  const result = await runCodingTask({ base, key: 'test-key', workspace: dir, task: 'Write sum.js with a test, run it and fix any failure.', approve: async (name, args) => { approvals.push(name); return true; } });
  assert.equal(result.final, 'Fixed sum.js (a - b → a + b); node --test now passes.');
  assert.equal(await fs.readFile(path.join(dir, 'sum.js'), 'utf8'), 'export const sum = (a, b) => a + b;\n');
  assert.deepEqual(approvals, ['write_file', 'write_file', 'run_command', 'replace_in_file', 'run_command'], 'every local action went through the client approval hook');
  assert.equal(upstream.conversationCount, 1);
});

test('E2E: a denied action is reported to the model and no file is changed', async t => {
  const dir = await workspace(t);
  const plan = [
    () => ({ calls: [{ name: 'write_file', arguments: { path: 'index.html', content: '<title>x</title>' } }] }),
    last => { assert.equal(last, 'The user denied this action.'); return 'Understood, I did not create index.html.'; },
  ];
  const { base } = await gateway(t, codingModel(plan));
  const result = await runCodingTask({ base, key: 'test-key', workspace: dir, approve: async () => false });
  assert.equal(result.final, 'Understood, I did not create index.html.');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('E2E: tool paths cannot escape the client workspace', async t => {
  const dir = await workspace(t);
  const plan = [
    () => ({ calls: [{ name: 'write_file', arguments: { path: '../escaped.txt', content: 'x' } }] }),
    last => { assert.match(last, /escapes the workspace/); return 'Stopped.'; },
  ];
  const { base } = await gateway(t, codingModel(plan));
  await runCodingTask({ base, key: 'test-key', workspace: dir });
  await assert.rejects(fs.access(path.join(path.dirname(dir), 'escaped.txt')));
});

// Minimal OpenAI-compatible client used by the tests. Its stream accumulator is
// deliberately strict: it applies the same checks as @ai-sdk/openai-compatible
// (used by Cline) and Roo Code when they rebuild tool calls from SSE deltas.

import assert from 'node:assert/strict';

export function parseSse(text) {
  const events = text.split('\n\n').filter(e => e.startsWith('data: ')).map(e => e.slice(6));
  const done = events.at(-1) === '[DONE]';
  const chunks = events.filter(e => e !== '[DONE]').map(e => JSON.parse(e));
  return { chunks, done, comments: text.split('\n\n').filter(e => e.startsWith(':')).length };
}

/** Rebuilds the assistant message from chunks, enforcing OpenAI streaming rules. */
export function accumulate(chunks) {
  let role = null, content = '', finish = null, usage, sawFinish = false;
  const calls = [];
  const ids = new Set(chunks.map(c => c.id));
  assert.equal(ids.size, 1, 'all chunks share one completion id');
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk');
    if (chunk.error) throw Object.assign(new Error('stream error: ' + chunk.error.code), { payload: chunk.error });
    if (Object.hasOwn(chunk, 'usage')) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      assert.equal(choice.index, 0);
      assert(!sawFinish, 'no deltas after finish_reason');
      const delta = choice.delta ?? {};
      if (delta.role) { assert.equal(role, null, 'role is sent once'); role = delta.role; }
      if (typeof delta.content === 'string') { assert(!calls.length, 'content precedes tool call deltas'); content += delta.content; }
      for (const call of delta.tool_calls ?? []) {
        assert(Number.isInteger(call.index), 'tool call delta has an index');
        if (!calls[call.index]) {
          assert.equal(call.index, calls.length, 'tool call indexes are sequential');
          assert.equal(typeof call.id, 'string', "first delta has the tool call id (AI SDK: Expected 'id' to be a string)");
          assert.equal(call.type, 'function');
          assert.equal(typeof call.function?.name, 'string', "first delta has the function name (AI SDK: Expected 'function.name' to be a string)");
          calls[call.index] = { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments ?? '' } };
        } else {
          assert(call.id === undefined || call.id === calls[call.index].id);
          assert(call.function?.name === undefined || call.function.name === calls[call.index].function.name);
          calls[call.index].function.arguments += call.function?.arguments ?? '';
        }
      }
      if (choice.finish_reason) { finish = choice.finish_reason; sawFinish = true; }
    }
  }
  assert.equal(role, 'assistant', 'a role delta is sent first');
  for (const call of calls) JSON.parse(call.function.arguments);
  return { role, content, toolCalls: calls, finish, usage };
}

export function client(base, key = 'test-key') {
  async function post(body, { headers = {}, signal } = {}) {
    return fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  }
  /** Sends one completion request and returns the assistant message as a client would see it. */
  async function complete(body, options) {
    const response = await post(body, options);
    if (!response.ok) return { response, error: await response.json() };
    if (body.stream) {
      const stream = parseSse(await response.text());
      assert(stream.done, 'stream ends with [DONE]');
      const message = accumulate(stream.chunks);
      return { response, stream, message: { role: 'assistant', content: message.content || null, ...(message.toolCalls.length ? { tool_calls: message.toolCalls } : {}) }, finish: message.finish, chunks: stream.chunks };
    }
    const json = await response.json();
    return { response, json, message: json.choices[0].message, finish: json.choices[0].finish_reason };
  }
  return { post, complete };
}

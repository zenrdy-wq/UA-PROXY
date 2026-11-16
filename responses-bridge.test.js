'use strict';
// Unit tests for the Responses <-> Chat Completions bridge (no sockets).
const assert = require('node:assert/strict');
const {
  chatToResponses, responsesToChat, createStreamTranslator, emitResponseAsChatStream,
} = require('./responses-bridge');
let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.deepEqual(a, b, msg); checks++; }

// --- request: chat -> responses ---
const req = chatToResponses({
  model: 'gpt-5.6-sol',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'developer', content: 'Be terse.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'greet', arguments: '{"name":"Bob"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Hi Bob' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:img' } }] },
  ],
  tools: [{ type: 'function', function: { name: 'greet', description: 'Greet', parameters: { type: 'object' }, strict: true } }],
  tool_choice: { type: 'function', function: { name: 'greet' } },
  max_tokens: 128, temperature: 0.5, top_p: 0.9, reasoning_effort: 'high',
  response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } },
  stream: true,
});
eq(req.instructions, 'You are helpful.\n\nBe terse.', 'system+developer -> instructions');
ok(!req.messages, 'no messages field leaks');
eq(req.input[0], { role: 'user', content: 'Hi' }, 'plain user message');
eq(req.input[1], { type: 'function_call', call_id: 'call_1', name: 'greet', arguments: '{"name":"Bob"}' }, 'assistant tool_call -> function_call');
eq(req.input[2], { role: 'assistant', content: 'Hello' }, 'assistant text -> output');
eq(req.input[3], { type: 'function_call_output', call_id: 'call_1', output: 'Hi Bob' }, 'tool result -> function_call_output');
eq(req.input[4], { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:img' }] }, 'multimodal parts');
eq(req.tools[0], { type: 'function', name: 'greet', description: 'Greet', parameters: { type: 'object' }, strict: true }, 'tool flattening');
eq(req.tool_choice, { type: 'function', name: 'greet' }, 'tool_choice mapping');
eq(req.max_output_tokens, 128, 'max_tokens -> max_output_tokens');
eq(req.reasoning, { effort: 'high' }, 'reasoning_effort -> reasoning');
eq(req.text, { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } }, 'response_format -> text.format');
eq(req.stream, true, 'stream passthrough');

// max_completion_tokens wins over max_tokens
eq(chatToResponses({ model: 'm', messages: [], max_tokens: 10, max_completion_tokens: 20 }).max_output_tokens, 20, 'max_completion_tokens priority');
// string tool_choice
eq(chatToResponses({ model: 'm', messages: [], tool_choice: 'required' }).tool_choice, 'required', 'string tool_choice');

// --- response: responses -> chat (non-stream) ---
const chat = responsesToChat({
  id: 'resp_abc', model: 'gpt-5.6-sol', status: 'completed',
  output: [
    { type: 'reasoning', encrypted_content: 'x' },
    { type: 'message', content: [{ type: 'output_text', text: 'Hello ' }, { type: 'output_text', text: 'world' }] },
    { type: 'function_call', call_id: 'call_9', name: 'greet', arguments: '{"name":"Bob"}' },
  ],
  usage: { input_tokens: 12, output_tokens: 75, total_tokens: 87,
    input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 61 } },
}, 'fallback-model');
eq(chat.object, 'chat.completion', 'object type');
ok(chat.id.startsWith('chatcmpl-'), 'chat id prefix');
eq(chat.model, 'gpt-5.6-sol', 'model passthrough');
eq(chat.choices[0].message.content, 'Hello \n\nworld', 'text parts joined');
eq(chat.choices[0].message.tool_calls, [{ id: 'call_9', type: 'function', function: { name: 'greet', arguments: '{"name":"Bob"}' } }], 'tool_calls mapped');
eq(chat.choices[0].finish_reason, 'tool_calls', 'finish_reason tool_calls');
eq(chat.usage, { prompt_tokens: 12, completion_tokens: 75, total_tokens: 87, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 61 } }, 'usage mapping');

// text-only finish_reason + length
eq(responsesToChat({ id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }).choices[0].finish_reason, 'stop', 'stop finish');
eq(responsesToChat({ id: 'r', output: [], incomplete_details: { reason: 'max_output_tokens' } }).choices[0].finish_reason, 'length', 'length finish');
// tool-only message content null
eq(responsesToChat({ id: 'r', output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] }).choices[0].message.content, null, 'tool-only content null');

// --- streaming translator ---
function runStream(events, { includeUsage = true } = {}) {
  const out = [];
  const t = createStreamTranslator({ model: 'gpt-5.6-sol', includeUsage, write: (s) => out.push(s) });
  for (const e of events) t.event(JSON.stringify(e));
  t.end();
  return out.map((s) => s.replace(/^data: /, '').trim()).filter((s) => s !== '[DONE]')
    .map((s) => { try { return JSON.parse(s); } catch { return s; } });
}
const streamed = runStream([
  { type: 'response.created', response: { model: 'gpt-5.6-sol' } },
  { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo' },
  { type: 'response.output_item.added', item: { id: 'fc1', type: 'function_call', call_id: 'call_x', name: 'greet', arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"na' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: 'me":"Bob"}' },
  { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call_x', name: 'greet', arguments: '{"name":"Bob"}' }], usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } } },
]);
ok(streamed[0].choices[0].delta.role === 'assistant', 'first chunk role');
eq(streamed.filter((c) => c.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content).join(''), 'Hello', 'text deltas');
const toolDeltas = streamed.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
ok(toolDeltas.some((t) => t.id === 'call_x' && t.function?.name === 'greet'), 'tool call id+name emitted');
eq(toolDeltas.filter((t) => t.function?.arguments).map((t) => t.function.arguments).join(''), '{"name":"Bob"}', 'tool args streamed');
const finishChunk = streamed.find((c) => c.choices?.[0]?.finish_reason);
eq(finishChunk.choices[0].finish_reason, 'tool_calls', 'stream finish_reason');
const usageChunk = streamed.find((c) => c.usage && (!c.choices || c.choices.length === 0));
eq(usageChunk.usage.total_tokens, 11, 'usage chunk emitted');
ok(streamed.every((c) => c.object === 'chat.completion.chunk'), 'all chunks correct object');
// same id across chunks
ok(new Set(streamed.map((c) => c.id)).size === 1, 'stable chunk id');

// includeUsage=false suppresses usage chunk
const noUsage = runStream([
  { type: 'response.created' },
  { type: 'response.output_text.delta', delta: 'x' },
  { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
], { includeUsage: false });
ok(!noUsage.some((c) => c.usage), 'usage suppressed when includeUsage=false');

// failed response surfaces error, no success finish
const failed = runStream([
  { type: 'response.created' },
  { type: 'response.failed', response: { error: { message: 'boom', code: 'x', type: 'server_error' } } },
]);
ok(failed.some((c) => c.error && c.error.message === 'boom'), 'failed -> error chunk');
ok(!failed.some((c) => c.choices?.[0]?.finish_reason), 'no finish on failure');

// response.incomplete is a legitimate end of turn (limit reached), not an error.
const incomplete = runStream([
  { type: 'response.created' },
  { type: 'response.output_text.delta', delta: 'partial' },
  { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    usage: { input_tokens: 2, output_tokens: 9, total_tokens: 11 } } },
]);
ok(incomplete.some((c) => c.choices?.[0]?.finish_reason === 'length'), 'incomplete -> finish_reason length');
ok(!incomplete.some((c) => c.error), 'incomplete is not an error');
ok(incomplete.some((c) => c.usage && c.usage.total_tokens === 11), 'incomplete carries usage');
const filtered = runStream([
  { type: 'response.created' },
  { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' }, output: [] } },
]);
ok(filtered.some((c) => c.choices?.[0]?.finish_reason === 'content_filter'), 'content_filter reason mapped');

// truncated stream (end without completed) still terminates cleanly
const trunc = runStream([{ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'partial' }]);
ok(trunc.some((c) => c.choices?.[0]?.finish_reason === 'stop'), 'truncated stream gets stop');

// --- emitResponseAsChatStream (JSON -> SSE replay) ---
const replay = [];
emitResponseAsChatStream({
  id: 'r', model: 'm', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there' }] }],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
}, { model: 'm', includeUsage: true }, (s) => replay.push(s));
const replayParsed = replay.map((s) => s.replace(/^data: /, '').trim()).filter((s) => s !== '[DONE]').map((s) => JSON.parse(s));
eq(replayParsed.filter((c) => c.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content).join(''), 'Hi there', 'replay text');
ok(replayParsed.some((c) => c.choices?.[0]?.finish_reason === 'stop'), 'replay finish');
ok(replay.some((s) => s.includes('[DONE]')), 'replay DONE');

console.log(`responses-bridge.test.js: ${checks} checks passed`);

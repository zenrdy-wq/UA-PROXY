'use strict';
// Sanity checks for rewriteBody: strips only the configured top-level keys,
// leaves everything else byte-identical, and never touches non-JSON bodies.

const assert = require('node:assert');
const { rewriteBody } = require('./lib.js');

const STRIP = ['reasoning_effort', 'reasoning', 'thinking'];

// Nothing configured, or nothing present: must be a no-op.
assert.strictEqual(rewriteBody(Buffer.from('{"a":1}'), []), null);
assert.strictEqual(rewriteBody(Buffer.from('{"a":1}'), STRIP), null);
assert.strictEqual(rewriteBody(Buffer.from(''), STRIP), null);
console.log('OK: no matching key -> no-op (body forwarded as-is)');

// Non-JSON must pass through untouched.
assert.strictEqual(rewriteBody(Buffer.from('not json at all'), STRIP), null);
assert.strictEqual(rewriteBody(Buffer.from('[1,2,3]'), STRIP), null);
console.log('OK: non-JSON / array bodies are left untouched');

// The real case: reasoning_effort removed, rest preserved.
const input = JSON.stringify({
  model: 'gs/claude-opus-5',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 900,
  stream: true,
  reasoning_effort: 'high',
});
const out = rewriteBody(Buffer.from(input), STRIP);
assert.ok(out, 'a rewrite result is required');
assert.deepStrictEqual(out.removed, ['reasoning_effort']);

const parsed = JSON.parse(out.body.toString('utf8'));
assert.ok(!('reasoning_effort' in parsed), 'reasoning_effort must be removed');
assert.strictEqual(parsed.model, 'gs/claude-opus-5');
assert.strictEqual(parsed.max_tokens, 900);
assert.strictEqual(parsed.stream, true);
assert.deepStrictEqual(parsed.messages, [{ role: 'user', content: 'hi' }]);
console.log('OK: reasoning_effort removed; other fields intact');

// Multiple keys at once.
const multi = rewriteBody(Buffer.from(JSON.stringify({
  model: 'm', thinking: { type: 'enabled' }, reasoning: { effort: 'high' }, keep: 1,
})), STRIP);
assert.deepStrictEqual(multi.removed.sort(), ['reasoning', 'thinking']);
assert.strictEqual(JSON.parse(multi.body.toString()).keep, 1);
console.log('OK: multiple keys removed at once');

// A nested field with the same name must survive — only top level is stripped.
const nested = rewriteBody(Buffer.from(JSON.stringify({
  model: 'm',
  reasoning_effort: 'high',
  metadata: { reasoning_effort: 'keep-me' },
})), STRIP);
const np = JSON.parse(nested.body.toString('utf8'));
assert.ok(!('reasoning_effort' in np));
assert.strictEqual(np.metadata.reasoning_effort, 'keep-me',
  'nested fields must not be removed');
console.log('OK: only top-level fields are removed; nested stays intact');

console.log('all rewriteBody assertions passed');

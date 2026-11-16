'use strict';
// Sanity check for createSseSanitizer: strips `data: null` frames (and the
// blank line that terminates them), preserves everything else, and survives a
// chunk boundary in the middle of a line.

const assert = require('node:assert');
const { createSseSanitizer } = require('./lib.js');

const s = createSseSanitizer();
const parts = [
  'data: {"a":1}\n\ndata: null\n\ndata: {"b"',
  ':2}\n\ndata: null\n\ndata: [DONE]\n\n',
];

let out = '';
for (const p of parts) {
  const kept = s.transform(Buffer.from(p, 'utf8'));
  if (kept) out += kept.toString('utf8');
}
const tail = s.flush();
if (tail) out += tail.toString('utf8');

console.log('output:', JSON.stringify(out));

assert.ok(!out.includes('data: null'), 'data: null frames must all be removed');
assert.strictEqual((out.match(/data: \{/g) || []).length, 2,
  'both JSON chunks must stay intact');
assert.strictEqual((out.match(/\[DONE\]/g) || []).length, 1,
  '[DONE] must pass through');
assert.ok(out.includes('{"b":2}'),
  'lines split across chunk boundaries must join intact');
assert.ok(!/\n\n\n/.test(out),
  'must not leave an empty frame');

// A null frame may be split exactly between its data line and terminator.
const split = createSseSanitizer();
let splitOut = '';
for (const part of ['data: null\n', '\ndata: {"ok":true}\n\n']) {
  const kept = split.transform(Buffer.from(part));
  if (kept) splitOut += kept.toString();
}
const splitTail = split.flush();
if (splitTail) splitOut += splitTail.toString();
assert.ok(!splitOut.includes('data: null'));
assert.ok(!splitOut.startsWith('\n'), 'a split terminator must not produce a blank event');
assert.ok(splitOut.includes('{"ok":true}'));
console.log('OK: a null frame whose terminator is split is dropped too');

// A multibyte UTF-8 code point may split across network chunks.
const utf8 = createSseSanitizer();
const utf8Source = Buffer.from('data: {"text":"café"}\n\n', 'utf8');
const splitAt = utf8Source.indexOf(Buffer.from('é')) + 1;
let utf8Out = '';
for (const part of [utf8Source.subarray(0, splitAt), utf8Source.subarray(splitAt)]) {
  const kept = utf8.transform(part);
  if (kept) utf8Out += kept.toString('utf8');
}
const utf8Tail = utf8.flush();
if (utf8Tail) utf8Out += utf8Tail.toString('utf8');
assert.ok(utf8Out.includes('café'), 'a split UTF-8 code point must stay intact');
assert.ok(!utf8Out.includes('�'));
console.log('OK: split multibyte UTF-8 stays intact');

console.log('OK: sanitizer passed all assertions');

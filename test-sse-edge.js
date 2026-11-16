'use strict';
const assert = require('node:assert');
const { createSseSanitizer } = require('./lib.js');

function run(parts) {
  const s = createSseSanitizer(); let out = '';
  for (const part of parts) { const r = s.transform(Buffer.from(part)); if (r) out += r; }
  const tail = s.flush(); if (tail) out += tail;
  return out;
}

const metadata = run(['event: old\nid: 1\ndata: null\n\ndata: {"ok":1}\n\n']);
assert.strictEqual(metadata, 'data: {"ok":1}\n\n');
const cr = run(['data: null\r\rdata: {"ok":1}\r\r']);
assert.ok(cr.includes('data: {"ok":1}'));
assert.ok(!cr.includes('data: null'));
console.log('sse edge tests OK');

'use strict';
const assert = require('node:assert');
const { createSseSanitizer } = require('./lib.js');
const { createSseParser, SSE_FRAME_LIMIT } = require('./sse');

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
// An oversized frame is reported once and parsing resumes afterwards.
const drops = []; const kept = [];
const parser = createSseParser(({ data }) => kept.push(data), { maxFrame: 100, strict: false, onDrop: (d) => drops.push(d) });
parser.push('data: ' + 'x'.repeat(200) + '\n\ndata: small\n\n');
parser.end();
assert.strictEqual(drops.length, 1, 'oversized frame reported exactly once');
assert.deepStrictEqual(kept, ['small'], 'parser recovers after a dropped frame');

// The shared limit must comfortably cover real Responses completion events.
assert.ok(SSE_FRAME_LIMIT >= 8 * 1024 * 1024, 'frame limit is generous');
let seen = 0;
const bigParser = createSseParser(() => { seen++; }, { maxFrame: SSE_FRAME_LIMIT, strict: false });
bigParser.push('data: ' + 'y'.repeat(64 * 1024) + '\n\n');
bigParser.end();
assert.strictEqual(seen, 1, '64 KiB frame passes with the shared limit');

console.log('sse edge tests OK');

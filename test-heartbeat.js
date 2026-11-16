'use strict';
// Sanity checks for startHeartbeat: fires only while idle, stays quiet once
// data flows, and is a no-op when disabled.

const assert = require('node:assert');
const { startHeartbeat } = require('./lib.js');

function fakeRes() {
  return {
    writableEnded: false,
    destroyed: false,
    written: [],
    write(chunk) { this.written.push(chunk); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Disabled: must never write.
  for (const value of [undefined, 0, null]) {
    const res = fakeRes();
    const h = startHeartbeat(res, value);
    h.touch();
    await sleep(120);
    h.stop();
    assert.strictEqual(res.written.length, 0, `heartbeatMs=${value} must be a no-op`);
    assert.strictEqual(h.beats, 0);
  }
  console.log('OK: empty/0 heartbeatMs writes nothing');

  // Idle: must emit comment frames. The timer ticks at most once per second
  // (floor guard in startHeartbeat), so this needs real seconds to observe.
  const idle = fakeRes();
  const hIdle = startHeartbeat(idle, 1000);
  await sleep(3400);
  hIdle.stop();
  assert.ok(hIdle.beats >= 2, `idle must beat, got ${hIdle.beats}`);
  assert.ok(idle.written.every((c) => c === ': keep-alive\n\n'),
    'may only write SSE comment frames');
  console.log(`OK: idle beat ${hIdle.beats}x with pure SSE comments`);

  // Busy: touch() before every tick must suppress all beats.
  const busy = fakeRes();
  const hBusy = startHeartbeat(busy, 2000);
  for (let i = 0; i < 6; i += 1) {
    await sleep(500);
    hBusy.touch();
  }
  hBusy.stop();
  assert.strictEqual(hBusy.beats, 0, 'an active stream must not receive heartbeats');
  console.log('OK: active stream has no heartbeat inserted');

  // Ended response: must not write after end.
  const ended = fakeRes();
  const hEnded = startHeartbeat(ended, 1000);
  ended.writableEnded = true;
  await sleep(2400);
  hEnded.stop();
  assert.strictEqual(ended.written.length, 0, 'must not write to a finished response');
  console.log('OK: finished response is not written to');

  console.log('all heartbeat assertions passed');
})();

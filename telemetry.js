'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openHistory, historyPath } = require('./history');
const { diagnose } = require('./diagnostics');

function createTelemetry(file = path.join(__dirname, 'runtime', 'metrics.json')) {
  const history = openHistory(historyPath(file));
  history.importLegacy(file);
  const startedAt = Date.now();
  const state = { pid: process.pid, startedAt, updatedAt: startedAt, total: 0, errors: 0,
    active: 0, durationMs: 0, recent: [], buckets: [] };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let dirty = true, closing = false, databaseClosed = false;
  function flush() {
    if (!dirty) return;
    state.updatedAt = Date.now();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file); dirty = false;
  }
  const timer = setInterval(flush, 1000); timer.unref(); flush();
  function track(req, res, route) {
    const began = Date.now(); state.active++; dirty = true;
    let done = false, diagnosis = null, upstreamStatus = null, logicalStatus = null;
    const id = randomUUID();
    res.setHeader?.('x-ua-request-id', id);
    const handle = {
      id,
      setRoute(value) { route = value; },
      error(status, value, source = 'upstream') {
        diagnosis = diagnose(status, value, source);
        if (source === 'upstream') upstreamStatus = status;
        if (status < 400) logicalStatus = 502;
      },
    };
    const complete = () => {
      if (done) return; done = true;
      const status = res.writableFinished ? (logicalStatus || res.statusCode) : 499;
      const durationMs = Date.now() - began;
      state.active--; state.total++; state.durationMs += durationMs;
      if (status >= 400) state.errors++;
      // Store endpoint classes only. Never retain queries, bodies, keys or arbitrary paths.
      const pathname = String(req.url || '').split('?')[0];
      const endpoint = ['/chat/completions', '/responses', '/messages', '/models', '/embeddings']
        .find(suffix => pathname.endsWith(suffix)) || '/other';
      const row = { id, at: Date.now(), method: req.method, upstream: route?.name || 'unknown',
        endpoint, status, durationMs, upstreamStatus,
        diagnosis: status >= 400 ? (diagnosis || diagnose(status, {}, status === 499 ? 'client' : 'upstream')) : null,
        origin: req.headers?.['x-ua-source'] === 'playground' ? 'playground' : 'proxy' };
      try { history.record(row); } catch { process.stderr.write('History write failed; gateway request completed.\n'); }
      state.recent.unshift(row);
      state.recent = state.recent.slice(0, 60);
      const minute = Math.floor(Date.now() / 60000) * 60000;
      let bucket = state.buckets.find(b => b.at === minute);
      if (!bucket) { bucket = { at: minute, count: 0, errors: 0 }; state.buckets.push(bucket); }
      bucket.count++; if (status >= 400) bucket.errors++;
      state.buckets = state.buckets.filter(b => b.at >= minute - 59 * 60000);
      dirty = true;
      if (closing && state.active === 0) finishClose();
    };
    res.once('finish', complete); res.once('close', complete);
    return handle;
  }
  function finishClose() { if (!databaseClosed) { flush(); history.close(); databaseClosed = true; } }
  return { track, flush, close() { closing = true; clearInterval(timer); flush(); if (state.active === 0) finishClose(); } };
}
module.exports = { createTelemetry };

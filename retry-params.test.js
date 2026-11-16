'use strict';
// Integration test: the proxy retries a 400 that names an unsupported
// parameter, stripping it from the request body, and remembers the decision.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }

async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-retry-'));
  const seen = [];
  let rejectCount = 0;

  // Fake upstream: rejects any body carrying `temperature`, then serves a
  // normal chat completion.
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => { raw += b; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      seen.push(Object.keys(body));
      if ('temperature' in body) {
        rejectCount++;
        const payload = JSON.stringify({
          error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error' },
        });
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      const payload = JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'retry worked' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));

  const pp = await freePort();
  const cfg = {
    host: '127.0.0.1', port: pp, publicMode: true,
    authToken: 'fixture-proxy-token-0000000000000000000000',
    defaultUpstream: 'fixture', heartbeatMs: 0,
    upstreams: {
      fixture: {
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'fixture-key',
      },
    },
  };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const env = { ...process.env, UA_PROXY_CONFIG: configFile, UA_PROXY_METRICS: path.join(dir, 'metrics.json') };
  const proxy = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  proxy.stderr.on('data', () => {});
  async function wait(url) {
    for (let n = 0; n < 80; n++) {
      try { if ((await fetch(url)).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('proxy did not start');
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.authToken}` };
  const post = (body) => fetch(`http://127.0.0.1:${pp}/fixture/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });

  try {
    await wait(`http://127.0.0.1:${pp}/_health`);

    // First request: upstream rejects, proxy retries without temperature.
    let r = await post({ model: 'fix-model', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    let data = await r.json();
    ok(r.status === 200, 'request succeeds after stripping the rejected parameter');
    ok(data.choices[0].message.content === 'retry worked', 'client gets the real completion');
    ok(rejectCount === 1, 'upstream rejected exactly once');
    ok(!('temperature' in (seen.at(-1) || [])), 'retried body carried no temperature');

    // Second request: the proxy remembers and skips the field up front.
    const before = rejectCount;
    r = await post({ model: 'fix-model', messages: [{ role: 'user', content: 'again' }], temperature: 0.9 });
    data = await r.json();
    ok(r.status === 200, 'second request succeeds');
    ok(rejectCount === before, 'no extra rejection on the second request (learned parameter)');
    ok(data.choices[0].message.content === 'retry worked', 'second completion intact');

    // A different model is not affected by the first model's memory.
    r = await post({ model: 'other-model', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 });
    ok(r.status === 200, 'other model still works even with temperature');
    ok(rejectCount === before + 1, 'other model tries temperature once before learning');
  } finally {
    proxy.kill('SIGTERM');
    await once(proxy, 'exit');
    await new Promise(r => upstream.close(r));
  }

  console.log(`retry-params.test.js: ${checks} checks passed`);
})();

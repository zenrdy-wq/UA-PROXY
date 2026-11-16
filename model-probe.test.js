'use strict';
const assert = require('node:assert');
const http = require('node:http');
const { fetchModels, parseBody, safeText, testModel } = require('./model-probe.js');

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    const body = JSON.stringify({ data: [{ id: 'gs/alpha' }, { id: 'jd/beta' }] });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body); return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.max_tokens, 24);
      const response = JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { reasoning_tokens: 3 } });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(response);
    }); return;
  }
  res.writeHead(404); res.end(JSON.stringify({ error: { message: 'missing' } }));
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const upstream = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret' };
  const catalog = await fetchModels(upstream);
  assert.deepStrictEqual(catalog.models, ['gs/alpha', 'jd/beta']);
  assert.strictEqual(catalog.ok, true);
  const tested = await testModel(upstream, 'gs/alpha');
  assert.strictEqual(tested.reply, 'OK');
  assert.strictEqual(tested.reasoningTokens, 3);
  assert.ok(safeText('secret\nraw').includes('secret raw'));
  assert.deepStrictEqual(parseBody('data: {"data":[]}\n\ndata: [DONE]\n'), { data: [] });
  server.close();
  console.log('model-probe tests OK');
});

'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MAX_BODY = 256 * 1024;
const DEFAULT_TIMEOUT = 10000;

function endpoint(baseUrl, path) {
  const base = new URL(baseUrl);
  const transport = base.protocol === 'https:' ? https : http;
  const port = base.port || (base.protocol === 'https:' ? 443 : 80);
  const prefix = base.pathname.replace(/\/$/, '');
  return { transport, hostname: base.hostname, port, path: `${prefix}${path}` || '/' };
}

function classify(status, body = '') {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'access denied';
  if (status === 402) return 'quota/credit exhausted';
  if (status === 404) return 'model or endpoint not found';
  if (status === 422) return 'invalid parameters';
  if (status === 503) return 'no channel available';
  if (/quota|credit|budget/i.test(body)) return 'quota/credit exhausted';
  return `HTTP ${status}`;
}

function parseBody(raw) {
  const text = raw.toString('utf8').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const chunks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') continue;
    try { chunks.push(JSON.parse(value)); } catch {}
  }
  if (chunks.length === 1) return chunks[0];
  return chunks.length ? { chunks } : null;
}

function safeText(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function request(upstream, path, body = null, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = endpoint(upstream.baseUrl, path); } catch (error) {
      resolve({ ok: false, kind: 'invalid URL', error: error.message }); return;
    }
    const headers = {
      accept: body ? 'application/json, text/event-stream' : 'application/json',
      ...(upstream.headers || {}),
    };
    if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`;
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = target.transport.request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: body ? 'POST' : 'GET',
      timeout,
      headers,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size >= MAX_BODY) return;
        const part = chunk.subarray(0, MAX_BODY - size);
        chunks.push(part); size += part.length;
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = parseBody(raw);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          kind: classify(res.statusCode, raw),
          body: parsed,
          text: safeText(parsed?.error?.message || parsed?.message || raw),
        });
      });
      res.on('aborted', () => resolve({ ok: false, kind: 'upstream aborted' }));
    });
    req.on('error', (error) => resolve({ ok: false, kind: error.code || 'network error', error: error.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, kind: 'timeout' }); });
    if (body) req.end(body); else req.end();
  });
}

async function fetchModels(upstream, options) {
  const started = Date.now();
  const result = await request(upstream, '/models', null, options);
  result.latencyMs = Date.now() - started;
  const data = result.body?.data;
  result.models = Array.isArray(data)
    ? data.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean)
    : [];
  return result;
}

async function testModel(upstream, model, options = {}) {
  const started = Date.now();
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply exactly: OK' }],
    max_tokens: 24,
    stream: false,
  });
  const result = await request(upstream, '/chat/completions', body, options);
  result.latencyMs = Date.now() - started;
  const choice = result.body?.choices?.[0];
  result.reply = safeText(choice?.message?.content || result.text, 100);
  result.reasoningTokens = result.body?.usage?.completion_tokens_details?.reasoning_tokens
    ?? result.body?.usage?.reasoning_tokens ?? null;
  return result;
}

module.exports = {
  DEFAULT_TIMEOUT,
  MAX_BODY,
  classify,
  endpoint,
  fetchModels,
  parseBody,
  safeText,
  testModel,
};

#!/usr/bin/env node
'use strict';
/**
 * ua-proxy — local reverse proxy that injects the headers an upstream gateway
 * demands (notably User-Agent) before forwarding.
 *
 * Some AI gateways reject requests whose User-Agent they do not recognise.
 * Clients such as ZCode cannot set per-provider headers, so they cannot reach
 * those gateways directly. This proxy sits in between and adds them.
 *
 * Routing: /<upstream>/<path> -> <upstream.baseUrl>/<path>
 * The Authorization header is forwarded untouched; no API key is stored here.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const telemetry = require('./telemetry').createTelemetry(process.env.UA_PROXY_METRICS);
const { createSseParser } = require('./sse');

const {
  loadConfig, resolveRoute, joinPath, buildHeaders, log, setConfig,
  createSseSanitizer, startHeartbeat, rewriteBody,
} = require('./lib.js');
const {
  chatToResponses, responsesToChat, createBridgedStream, emitResponseAsChatStream,
} = require('./responses-bridge.js');

let cfg = loadConfig();
setConfig(cfg);

// Parameters an upstream rejected for a given model, learned from a 400 that
// named them. Upstream routing can be non-deterministic: the same model may
// accept `temperature` on one request and reject it on the next depending on
// which provider it lands on, so this is a speed-up hint, not a hard rule.
// Entries expire so a parameter that becomes supported is tried again.
const UNSUPPORTED_TTL_MS = 30 * 60 * 1000;
const unsupportedParams = new Map(); // `${upstream}::${model}` -> Map(param -> at)

function learnedParams(upstreamName, model) {
  if (!model) return [];
  const entry = unsupportedParams.get(`${upstreamName}::${model}`);
  if (!entry) return [];
  const now = Date.now();
  const live = [];
  for (const [param, at] of entry) {
    if (now - at > UNSUPPORTED_TTL_MS) entry.delete(param);
    else live.push(param);
  }
  if (!entry.size) unsupportedParams.delete(`${upstreamName}::${model}`);
  return live;
}

function rememberParam(upstreamName, model, param) {
  if (!model || !param) return;
  const key = `${upstreamName}::${model}`;
  let entry = unsupportedParams.get(key);
  if (!entry) { entry = new Map(); unsupportedParams.set(key, entry); }
  entry.set(param, Date.now());
  if (unsupportedParams.size > 500) {
    unsupportedParams.delete(unsupportedParams.keys().next().value);
  }
}

const server = http.createServer((req, res) => {
  const started = Date.now();

  if (req.url === '/_health') {
    const body = JSON.stringify({
      ok: true,
      upstreams: Object.keys(cfg.upstreams),
      defaultUpstream: cfg.defaultUpstream,
      publicMode: cfg.publicMode,
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  const activity = telemetry.track(req, res, null);
  let route;
  try {
    route = resolveRoute(req.url);
  } catch {
    activity.error(400, {}, 'proxy');
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid request target' } }));
    return;
  }
  if (!route) {
    activity.error(404, {}, 'proxy');
    const body = JSON.stringify({
      error: {
        message: 'unknown upstream; use /<upstream>/<path> or set defaultUpstream',
        available: Object.keys(cfg.upstreams),
      },
    });
    res.writeHead(404, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    log('warn', `404 ${req.method} ${new URL(req.url, 'http://localhost').pathname}`);
    return;
  }

  activity.setRoute(route);

  if (cfg.accessRevoked || cfg.upstreams[route.name].enabled === false) {
    activity.error(403, { message: cfg.accessRevoked ? 'Proxy access revoked' : 'Channel disabled' }, 'proxy');
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: cfg.accessRevoked
      ? 'Proxy access is revoked. Generate a new proxy key in the local dashboard.'
      : 'Channel is disabled. Enable it in the local dashboard.' } }));
    return;
  }

  // Public mode is fail-closed: every request needs the proxy token. Local
  // installs leave publicMode false, preserving the no-token ZCode workflow.
  if (cfg.publicMode || req.headers['x-ua-public-gateway'] === '1') {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const provided = bearer || req.headers['x-proxy-token'] || '';
    const expected = Buffer.from(cfg.authToken || '', 'utf8');
    const candidate = Buffer.from(String(provided), 'utf8');
    const valid = candidate.length === expected.length
      && crypto.timingSafeEqual(candidate, expected);
    if (!valid) {
      activity.error(401, {}, 'proxy');
      const body = JSON.stringify({
        error: {
          message: 'unauthorized: missing or wrong proxy token',
          hint: 'send Authorization: Bearer <authToken> or x-proxy-token header',
        },
      });
      res.writeHead(401, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      log('warn', `401 unauthorized ${req.method} ${route.name}${route.rest}`);
      return;
    }
  }

  const upstream = cfg.upstreams[route.name];
  const base = new URL(upstream.baseUrl);
  const target = new URL(base.origin);
  target.pathname = joinPath(base.pathname, route.rest);
  target.search = route.search || '';

  const transport = target.protocol === 'https:' ? https : http;

  // `body` non-null means it was buffered and possibly rewritten, so it is sent
  // with an explicit length instead of streamed.
  const forward = (initialBody) => {
    // Buffer the client payload as text so a rejected request can be retried
    // with the offending parameter removed. Reasoning-only models (e.g.
    // reasoning-only models) answer 400 "Unsupported parameter: 'temperature'"
    // for fields that older chat clients send by default.
    let source = initialBody ? initialBody.toString('utf8') : null;
    const stripped = new Set();
    let retriesLeft = 4;
    let requestModel = null;
    if (source) {
      try {
        const peek = JSON.parse(source);
        if (peek && typeof peek === 'object' && typeof peek.model === 'string') requestModel = peek.model;
      } catch { /* not JSON */ }
    }
    // Start from what this model rejected before, so the common case needs one round-trip.
    for (const param of learnedParams(route.name, requestModel)) stripped.add(param);
    if (stripped.size) {
      log('debug', `  skipping known-unsupported for ${route.name}/${requestModel}: ${[...stripped].join(', ')}`);
    }

    const applyStripped = (text) => {
      if (!text || stripped.size === 0) return text;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
        let changed = false;
        for (const key of stripped) {
          if (key in parsed) { delete parsed[key]; changed = true; }
        }
        return changed ? JSON.stringify(parsed) : text;
      } catch {
        return text;
      }
    };

    const buildOutbound = () => {
      const patchedSource = applyStripped(source);
      let body = patchedSource == null ? null : Buffer.from(patchedSource, 'utf8');
      let targetUrl = target;
      let bridge = null;

      const mode = req.headers['x-ua-chat-via'] === 'off'
        ? null
        : (req.headers['x-ua-chat-via'] || upstream.chatVia);
      if (body && mode === 'responses' && /\/chat\/completions\/?$/.test(route.rest)) {
        try {
          const parsed = JSON.parse(patchedSource);
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
            bridge = {
              model: parsed.model || null,
              stream: parsed.stream === true,
              includeUsage: parsed.stream_options?.include_usage !== false,
            };
            body = Buffer.from(JSON.stringify(chatToResponses(parsed)), 'utf8');
            targetUrl = new URL(target.href);
            targetUrl.pathname = targetUrl.pathname.replace(/\/chat\/completions\/?$/, '/responses');
            log('info', `  bridging ${route.name} chat/completions -> responses`);
          }
        } catch { /* not JSON; forward as-is */ }
      }

      // A parameter that exists only after translation (e.g. `reasoning`
      // derived from `reasoning_effort`) has to be removed from the outbound
      // body as well.
      if (body && stripped.size) {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          if (parsed && typeof parsed === 'object') {
            let changed = false;
            for (const key of stripped) {
              if (key in parsed) { delete parsed[key]; changed = true; }
            }
            if (changed) body = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        } catch { /* leave body untouched */ }
      }

      return { body, targetUrl, bridge };
    };

    const handleBridgedResponse = (bridge, proxyRes, proxyReq) => {
      const isUpstreamSse = (proxyRes.headers['content-type'] || '')
        .includes('text/event-stream');

      const respondJson = (payload) => {
        const out = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(proxyRes.statusCode || 502, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(out),
          'x-ua-request-id': activity.id,
        });
        res.end(out);
        log('info', `${proxyRes.statusCode} ${req.method} ${route.name}${route.rest} (${Date.now() - started}ms)`);
      };

      if (bridge.stream && isUpstreamSse) {
        res.writeHead(proxyRes.statusCode || 502, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-ua-request-id': activity.id,
        });
        const heartbeat = startHeartbeat(res, upstream.heartbeatMs ?? cfg.heartbeatMs, () => {});
        const bridged = createBridgedStream({
          model: bridge.model,
          includeUsage: bridge.includeUsage,
          res,
          heartbeat,
          activity,
        });
        proxyRes.on('data', (chunk) => bridged.push(chunk));
        proxyRes.on('end', () => bridged.end());
        proxyRes.on('error', (err) => {
          heartbeat.stop();
          log('error', `bridged upstream ${route.name}: ${err.message}`);
          res.destroy();
        });
        proxyRes.on('aborted', () => { heartbeat.stop(); res.destroy(); });
        res.on('close', () => { if (!res.writableFinished) { proxyRes.destroy(); proxyReq.destroy(); } });
        return;
      }

      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!bridge.stream) {
          if (isUpstreamSse) {
            // Provider streamed although the client asked for JSON: collect
            // the final response event and answer one converted JSON body.
            let response = null;
            const parser = createSseParser(({ data }) => {
              try {
                const evt = JSON.parse(data);
                if (evt?.type === 'response.completed') response = evt.response;
              } catch { /* ignore malformed events */ }
            }, { maxFrame: 32768, strict: false });
            parser.push(raw);
            parser.end();
            if (response) { respondJson(responsesToChat(response, bridge.model)); return; }
            activity.error(proxyRes.statusCode || 500, { code: 'stream_incomplete' });
            respondJson({ error: { message: 'upstream stream ended without a completed response' } });
            return;
          }
          try {
            respondJson(responsesToChat(JSON.parse(raw), bridge.model));
          } catch {
            // Conversion failed; hand the raw body back so the client sees the real error.
            respondJson(raw);
          }
          return;
        }
        // Client asked to stream but the upstream answered with one JSON body.
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* fall through */ }
        if (!parsed) { respondJson(raw); return; }
        res.writeHead(proxyRes.statusCode || 502, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-ua-request-id': activity.id,
        });
        emitResponseAsChatStream(parsed, bridge, (payload) => res.write(payload));
        res.end();
        log('info', `${proxyRes.statusCode} ${req.method} ${route.name}${route.rest} (${Date.now() - started}ms)`);
      });
      proxyRes.on('aborted', () => res.destroy());
    };

    const relayResponse = (proxyRes, prefetched) => {
      const isSse = (proxyRes.headers['content-type'] || '')
        .includes('text/event-stream');
      if (prefetched !== null) {
        // Body was read to look for an unsupported parameter; forward it verbatim.
        activity.error(proxyRes.statusCode, prefetched);
        const out = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          const lower = k.toLowerCase();
          if (['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer'].includes(lower)) continue;
          out[k] = v;
        }
        out['content-length'] = String(Buffer.byteLength(prefetched));
        out['x-ua-request-id'] = activity.id;
        res.writeHead(proxyRes.statusCode || 502, out);
        res.end(prefetched);
        log('info', `${proxyRes.statusCode} ${req.method} ${route.name}${route.rest} (${Date.now() - started}ms)`);
        return;
      }

      // Inspect only structured error metadata; no provider text is persisted.
      if (proxyRes.statusCode >= 400) {
        let errorBody = '';
        proxyRes.on('data', chunk => { if (errorBody.length < 16384) errorBody += chunk.toString('utf8').slice(0,16384-errorBody.length); });
        proxyRes.on('end', () => activity.error(proxyRes.statusCode, errorBody));
      } else if (isSse) {
        let complete = false, sawError = false;
        const observer = createSseParser(({event,data}) => {
          if (data === '[DONE]' || ['message_stop','response.completed'].includes(event)) complete = true;
          try {
            const body = JSON.parse(data);
            if (body?.choices?.some(c => c.finish_reason) || body?.type === 'message_stop' || body?.type === 'response.completed') complete = true;
            if (event === 'error' || body?.error) { sawError = true; activity.error(proxyRes.statusCode, body); }
          } catch {}
        }, {maxFrame: 32768, strict: false});
        proxyRes.on('data', chunk => observer.push(chunk));
        proxyRes.on('end', () => {
          observer.end();
          if (!complete && !sawError && /\/(?:chat\/completions|messages|responses)$/.test(route.rest))
            activity.error(proxyRes.statusCode, { code: 'stream_incomplete' });
        });
      } else if ((proxyRes.headers['content-type'] || '').includes('json')) {
        let body = '';
        proxyRes.on('data', chunk => { if (body.length < 16384) body += chunk.toString('utf8').slice(0,16384-body.length); });
        proxyRes.on('end', () => { try { const parsed = JSON.parse(body); if (parsed?.error) activity.error(proxyRes.statusCode, parsed); } catch {} });
      }
      proxyRes.on('aborted', () => activity.error(499, {}, 'upstream'));
      res.on('close', () => { if (!res.writableFinished) { proxyRes.destroy(); } });
      const out = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lower = k.toLowerCase();
        if (lower === 'transfer-encoding' || (isSse &&
            (lower === 'content-length' || lower === 'content-encoding'))) continue;
        if (lower !== 'connection' && lower !== 'keep-alive' && lower !== 'upgrade'
            && lower !== 'te' && lower !== 'trailer') out[k] = v;
      }
      out['x-ua-request-id'] = activity.id;
      res.writeHead(proxyRes.statusCode || 502, out);

      if (isSse && upstream.sanitizeSse !== false) {
        const sanitizer = createSseSanitizer();
        const beatMs = upstream.heartbeatMs ?? cfg.heartbeatMs;
        const heartbeat = startHeartbeat(res, beatMs, (n) => {
          if (n === 1) {
            log('debug', `heartbeat started for ${route.name}${route.rest}`);
          }
        });
        proxyRes.on('data', (chunk) => {
          const kept = sanitizer.transform(chunk);
          if (kept) {
            heartbeat.touch();
            res.write(kept);
          }
        });
        proxyRes.on('end', () => {
          heartbeat.stop();
          const tail = sanitizer.flush();
          if (tail) res.write(tail);
          res.end();
          if (heartbeat.beats) {
            log('info', `  sent ${heartbeat.beats} heartbeat frame(s) while idle`);
          }
        });
        proxyRes.on('error', (err) => {
          heartbeat.stop();
          log('error', `SSE upstream ${route.name}: ${err.message}`);
          if (!res.writableEnded) res.destroy();
        });
        proxyRes.on('aborted', () => {
          heartbeat.stop();
          if (!res.writableEnded) res.destroy();
        });
        res.on('close', () => {
          heartbeat.stop();
          proxyRes.destroy();
        });
      } else {
        proxyRes.pipe(res);
        proxyRes.on('error', (err) => {
          log('error', `upstream response ${route.name}: ${err.message}`);
          res.destroy();
        });
        proxyRes.on('aborted', () => res.destroy());
      }

      proxyRes.on('end', () => {
        log('info',
          `${proxyRes.statusCode} ${req.method} ${route.name}${route.rest} ` +
          `(${Date.now() - started}ms)`);
      });
    };

    const attempt = () => {
      const { body, targetUrl, bridge } = buildOutbound();
      const headers = buildHeaders(req.headers, upstream, targetUrl);
      if (body) headers['content-length'] = String(body.length);

      const proxyReq = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: targetUrl.pathname + targetUrl.search,
          headers,
        },
        (proxyRes) => {
          // A 400 naming an unsupported parameter is recoverable: drop that
          // field and retry once per parameter (bounded by retriesLeft).
          if (proxyRes.statusCode === 400 && retriesLeft > 0 && body) {
            let errorBody = '';
            proxyRes.on('data', (chunk) => {
              if (errorBody.length < 8192) errorBody += chunk.toString('utf8').slice(0, 8192 - errorBody.length);
            });
            proxyRes.on('end', () => {
              const match = /Unsupported parameter:\s*'([^']+)'/.exec(errorBody);
              const param = match && match[1];
              if (param && !stripped.has(param)) {
                stripped.add(param);
                retriesLeft -= 1;
                rememberParam(route.name, requestModel, param);
                log('warn', `  retrying ${route.name}${route.rest} without unsupported parameter '${param}'`);
                attempt();
                return;
              }
              relayResponse(proxyRes, errorBody);
            });
            proxyRes.on('error', () => relayResponse(proxyRes, errorBody));
            return;
          }
          if (bridge && (proxyRes.statusCode || 500) < 400) {
            handleBridgedResponse(bridge, proxyRes, proxyReq);
            return;
          }
          relayResponse(proxyRes, null);
        },
      );

      proxyReq.on('error', (err) => {
        activity.error(err.code === 'ETIMEDOUT' ? 504 : 502, { code: err.code }, 'network');
        log('error', `upstream ${route.name}: ${err.message}`);
        if (res.headersSent) { res.destroy(); return; }
        const payload = JSON.stringify({
          error: { message: `upstream request failed: ${err.message}`, upstream: route.name },
        });
        res.writeHead(502, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
      });

      // Client hung up mid-flight: drop the upstream request too.
      req.on('aborted', () => proxyReq.destroy());
      res.on('close', () => { if (!res.writableFinished) proxyReq.destroy(); });

      if (body) {
        proxyReq.end(body);
      } else {
        req.pipe(proxyReq);
      }
    };

    attempt();
  };

  const strip = upstream.stripBodyKeys;
  const mayHaveBody = req.method === 'POST' || req.method === 'PUT'
    || req.method === 'PATCH';

  if (mayHaveBody) {
    const parts = [];
    let bodyBytes = 0;
    let tooLarge = false;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > cfg.maxBodyBytes) {
      activity.error(413, {}, 'proxy');
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request body too large' } }));
      req.destroy();
      return;
    }
    req.on('data', (c) => {
      bodyBytes += c.length;
      if (bodyBytes > cfg.maxBodyBytes) {
        activity.error(413, {}, 'proxy');
        tooLarge = true;
        if (!res.headersSent) {
          const payload = JSON.stringify({ error: { message: 'request body too large' } });
          res.writeHead(413, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
        }
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(parts);
      const result = rewriteBody(raw, strip);
      if (result) {
        log('info', `  stripped ${result.removed.join(', ')} from ${route.name} body`);
        forward(result.body);
      } else {
        forward(raw);
      }
    });
    req.on('error', () => res.destroy());
  } else {
    forward(null);
  }
});

// Keep long model streams alive while bounding incomplete/slow requests.
server.timeout = 120000;
server.headersTimeout = 30000;
server.requestTimeout = 120000;

server.listen(cfg.port, cfg.host, () => {
  log('info', `ua-proxy listening on http://${cfg.host}:${cfg.port}`);
  for (const [name, up] of Object.entries(cfg.upstreams)) {
    const injected = Object.keys(up.headers || {}).join(', ') || '(none)';
    const beat = up.heartbeatMs ?? cfg.heartbeatMs;
    const beatLabel = beat > 0 ? `${beat}ms` : 'off';
    log('info', `  /${name} -> ${up.baseUrl}   headers: ${injected}   heartbeat: ${beatLabel}`);
  }
  if (cfg.defaultUpstream) {
    log('info', `  default upstream: ${cfg.defaultUpstream}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    telemetry.close();
    log('info', `${sig} received, shutting down`);
    let forced = false;
    const forceTimer = setTimeout(() => {
      forced = true;
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
    }, 5000);
    forceTimer.unref?.();
    server.close(() => {
      if (!forced) {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
  });
}

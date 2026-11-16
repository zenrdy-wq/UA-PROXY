'use strict';
/**
 * Shared helpers for ua-proxy: config loading, route resolution, path joining,
 * and header construction. Kept separate from server.js so the routing rules
 * can be unit-tested without opening a socket.
 */

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const { validateConfig } = require('./config-store.js');

const CONFIG_PATH = process.env.UA_PROXY_CONFIG
  || path.join(__dirname, 'config.json');

// Headers describing the client-proxy hop; must not be relayed upstream.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

const FORBIDDEN_CLIENT_HEADERS = new Set([
  ...HOP_BY_HOP,
  'authorization', 'proxy-authorization', 'x-api-key', 'x-proxy-token',
  'x-ua-public-gateway', 'x-ua-remote-ui', 'x-ua-source', 'x-ua-request-id', 'cookie', 'set-cookie', 'forwarded', 'via', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'cf-ray', 'cf-visitor',
]);

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MIN_TOKEN_LENGTH = 32;
// Stable for the proxy's lifetime: some gateways correlate turns by session id.
const SESSION_ID = randomUUID();

function isValidAuthToken(value) {
  return typeof value === 'string'
    && value.length >= MIN_TOKEN_LENGTH
    && !value.startsWith('REPLACE_')
    && !/[\s]/.test(value);
}

let cfg = null;

function loadConfig(configPath = CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateConfig(raw, { publicMode: raw.publicMode });
  return {
    host: raw.host || '127.0.0.1',
    port: raw.port || 8787,
    logLevel: raw.logLevel || 'info',
    heartbeatMs: raw.heartbeatMs ?? 0,
    authToken: raw.authToken || null,
    publicMode: Boolean(raw.publicMode),
    accessRevoked: raw.accessRevoked === true,
    maxBodyBytes: raw.maxBodyBytes || 10 * 1024 * 1024,
    upstreams: raw.upstreams,
    defaultUpstream: raw.defaultUpstream || null,
  };
}

function setConfig(next) {
  cfg = next;
}

function log(level, msg) {
  const active = cfg ? cfg.logLevel : 'info';
  if (LEVELS[level] > LEVELS[active]) return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}\n`);
}

/** Split "/provider-a/chat/completions" into upstream name plus remainder. */
function resolveRoute(reqUrl, config = cfg) {
  const parsed = new URL(reqUrl, 'http://localhost');
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (segments.length && Object.hasOwn(config.upstreams, segments[0])) {
    const name = segments.shift();
    return { name, rest: '/' + segments.join('/'), search: parsed.search };
  }
  if (config.defaultUpstream) {
    return {
      name: config.defaultUpstream,
      rest: parsed.pathname,
      search: parsed.search,
    };
  }
  return null;
}

/**
 * Join the upstream base path with the client path without duplicating the
 * API version segment: base ".../v1" + rest "/v1/responses" -> ".../v1/responses".
 */
function joinPath(basePath, rest) {
  const base = basePath.replace(/\/+$/, '');
  let tail = rest.startsWith('/') ? rest : '/' + rest;
  const baseLast = base.split('/').filter(Boolean).pop();
  const tailSegments = tail.split('/').filter(Boolean);
  if (baseLast && baseLast === tailSegments[0]) {
    tail = '/' + tailSegments.slice(1).join('/');
  }
  return (base + tail) || '/';
}

function buildHeaders(clientHeaders, upstream, target) {
  const out = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!FORBIDDEN_CLIENT_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out.host = target.host;
  out['accept-encoding'] = 'identity';

  // Configured headers win over whatever the client sent.
  for (const [k, v] of Object.entries(upstream.headers || {})) out[k] = v;

  // When the proxy holds the real key, swap the client token out here so the
  // upstream key never has to live on remote devices.
  if (upstream.apiKey) {
    out.authorization = `Bearer ${upstream.apiKey}`;
    out['x-api-key'] = upstream.apiKey;
  } else if (!cfg?.publicMode && clientHeaders.authorization) {
    out.authorization = clientHeaders.authorization;
  }

  if (upstream.injectSessionHeaders) {
    out['session-id'] = SESSION_ID;
    out['thread-id'] = SESSION_ID;
    out['x-client-request-id'] = randomUUID();
  }
  return out;
}

/**
 * Drop `data: null` frames from an SSE stream.
 *
 * Some gateways emit them between real chunks on some models. A strict SSE
 * client parses `null` as a valid JSON value, finds no `choices`, and aborts
 * the turn. Every other frame is passed through byte for byte.
 *
 * Returns a transform function over chunks plus a flush for the trailing
 * partial line.
 */
function createSseSanitizer() {
  let buffer = '';
  let eventLines = [];
  let eventHasNull = false;
  const decoder = new StringDecoder('utf8');

  // Buffer complete SSE events so a dropped `data: null` also drops its
  // preceding event/id metadata, even when the terminator arrives later.
  const strip = (lines, flushAtEnd = false) => {
    const kept = [];
    const flush = (terminator = null) => {
      if (!eventHasNull) {
        kept.push(...eventLines);
        if (terminator !== null) kept.push('');
      }
      eventLines = [];
      eventHasNull = false;
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '') flush(rawLine);
      else if (line === 'data: null') eventHasNull = true;
      else eventLines.push(rawLine);
    }
    if (flushAtEnd) flush();
    return kept;
  };


  return {
    transform(chunk) {
      buffer += decoder.write(chunk);
      const lines = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] !== '\n' && buffer[i] !== '\r') continue;
        if (buffer[i] === '\r' && i === buffer.length - 1) break;
        lines.push(buffer.slice(start, i));
        if (buffer[i] === '\r' && buffer[i + 1] === '\n') i += 1;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      const kept = strip(lines);
      return kept.length ? Buffer.from(kept.join('\n') + '\n', 'utf8') : null;
    },
    flush() {
      buffer += decoder.end();
      if (!buffer && !eventLines.length && !eventHasNull) return null;
      const lines = buffer ? [buffer] : [''];
      buffer = '';
      const kept = strip(lines, true);
      return kept.length ? Buffer.from(kept.join('\n'), 'utf8') : null;
    },
  };
}

/**
 * Keep an idle SSE connection alive with periodic comment frames.
 *
 * A gateway can stay silent for a long time while a model reasons — Agent
 * Router went 45-76s with no bytes at all on `claude-opus-5`. Clients and
 * intermediaries treat that silence as a dead connection and cut the turn.
 * A `:` comment line is valid SSE that every compliant parser ignores, so it
 * resets those idle timers without altering the payload.
 *
 * Returns { touch, stop, beats }: call touch() on every upstream chunk, stop()
 * when the response ends. `beats` counts frames actually sent.
 */
function startHeartbeat(res, intervalMs, onBeat) {
  if (!intervalMs || intervalMs <= 0) return { touch() {}, stop() {}, beats: 0 };

  let last = Date.now();
  const state = { beats: 0 };
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - last < intervalMs) return;
    res.write(': keep-alive\n\n');
    state.beats += 1;
    last = Date.now();
    onBeat?.(state.beats);
  }, Math.max(1000, Math.floor(intervalMs / 2)));
  timer.unref?.();

  return {
    touch() { last = Date.now(); },
    stop() { clearInterval(timer); },
    get beats() { return state.beats; },
  };
}

/**
 * Rewrite a JSON request body before forwarding.
 *
 * `stripKeys` removes top-level fields the upstream cannot handle. Some
 * gateways translate optional fields into a form their backend rejects; when
 * the model does not need the field, dropping it is what makes the request
 * valid.
 *
 * Returns the new body Buffer, or null when nothing changed.
 */
function rewriteBody(raw, stripKeys) {
  if (!stripKeys || stripKeys.length === 0 || !raw || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null; // not JSON; forward untouched
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const removed = [];
  for (const key of stripKeys) {
    if (key in parsed) {
      delete parsed[key];
      removed.push(key);
    }
  }
  if (removed.length === 0) return null;
  return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), removed };
}

module.exports = {
  CONFIG_PATH, SESSION_ID,
  loadConfig, setConfig, log, resolveRoute, joinPath, buildHeaders,
  createSseSanitizer, startHeartbeat, rewriteBody,
};

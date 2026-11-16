'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { loadConfig, writeConfigAtomic, DEFAULT_CONFIG_PATH, validateRouteName, generateToken } = require('./config-store');
const { fetchModels, testModel } = require('./model-probe');
const { openHistory, historyPath } = require('./history');
let history;
function getHistory() { return history ||= openHistory(historyPath()); }
const DIR = __dirname;
const UNIT = process.env.UA_PROXY_UNIT || 'ua-proxy.service';
const METRICS = process.env.UA_PROXY_METRICS || path.join(DIR, 'runtime', 'metrics.json');
const dashboardPort = Number(process.env.UA_DASHBOARD_PORT || 8788);
let queue = Promise.resolve();
function serialize(fn) {
  const result = queue.then(fn); queue = result.catch(() => {}); return result;
}
async function serviceInfo() {
  try {
    const { stdout } = await execFile('/usr/bin/systemctl', ['show', UNIT,
      '--property=ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic'], { timeout: 4000 });
    const values = Object.fromEntries(stdout.trim().split('\n').map(l => l.split('=')));
    return { running: values.ActiveState === 'active', state: values.ActiveState,
      pid: Number(values.MainPID) || null };
  } catch { return { running: false, state: 'unavailable', pid: null }; }
}
function redactedConfig(cfg) {
  const copy = structuredClone(cfg);
  delete copy.authToken;
  copy.tokenConfigured = Boolean(cfg.authToken) && !cfg.accessRevoked;
  for (const upstream of Object.values(copy.upstreams)) {
    upstream.keyConfigured = Boolean(upstream.apiKey); delete upstream.apiKey;
    upstream.secretHeaders = [];
    for (const name of Object.keys(upstream.headers || {})) {
      if (/auth|token|key|cookie|secret/i.test(name)) {
        upstream.secretHeaders.push(name); delete upstream.headers[name];
      }
    }
  }
  return copy;
}
function sanitize(value, cfg = loadConfig()) {
  let text = String(value || '');
  const secrets = [cfg.authToken, ...Object.values(cfg.upstreams).flatMap(u =>
    [u.apiKey, ...Object.entries(u.headers || {}).filter(([k]) => /auth|key|token|cookie|secret/i.test(k)).map(([,v]) => v)])];
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 1000);
}
async function snapshot() {
  const cfg = loadConfig();
  const service = await serviceInfo();
  let metrics = null;
  try { metrics = JSON.parse(fs.readFileSync(METRICS, 'utf8')); } catch {}
  if (!service.running || metrics?.pid !== service.pid) metrics = null;
  const retained = getHistory().summary();
  metrics = { ...retained, active: metrics?.active || 0, startedAt: metrics?.startedAt || null, pid: service.pid };
  let publicEndpoint = null;
  try { const url = new URL(JSON.parse(fs.readFileSync(path.join(DIR,'runtime','public-access.json'),'utf8')).origin); if(url.protocol==='https:' && url.hostname.endsWith('.ts.net')) publicEndpoint = url.origin; } catch {}
  return { config: redactedConfig(cfg), service, metrics, publicEndpoint, now: Date.now(),
    dashboard: `http://127.0.0.1:${dashboardPort}`, endpoint: `http://127.0.0.1:${cfg.port || 8787}` };
}
async function control(action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown service action');
  await execFile('/usr/bin/systemctl', [action, UNIT], { timeout: 20000 });
  if (action !== 'stop') {
    const cfg = loadConfig();
    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const host = cfg.host === '::1' ? '[::1]' : (cfg.host || '127.0.0.1');
        const response = await fetch(`http://${host}:${cfg.port || 8787}/_health`, { signal: AbortSignal.timeout(500) });
        const body = await response.json();
        if (response.ok && body.ok && (await serviceInfo()).running) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve,150));
    }
    if (!healthy) throw new Error('Proxy health check failed');
  }
  return { message: `Proxy ${action} complete.` };
}
async function saveAndApply(cfg) {
  // This workstation dashboard intentionally manages loopback listeners only.
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host || '127.0.0.1')) throw new Error('Use a loopback host');
  if (cfg.port === dashboardPort) throw new Error('Proxy and dashboard must use different ports');
  const old = loadConfig();
  const wasRunning = (await serviceInfo()).running;
  writeConfigAtomic(cfg);
  try {
    if (wasRunning) {
      await control('restart');
      if (!(await serviceInfo()).running) throw new Error('Proxy did not become healthy');
    }
  } catch (error) {
    writeConfigAtomic(old);
    // Keep the last-known-good backup useful after a failed apply, too.
    fs.writeFileSync(`${DEFAULT_CONFIG_PATH}.bak`, `${JSON.stringify(old, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(`${DEFAULT_CONFIG_PATH}.bak`, 0o600);
    if (wasRunning) { try { await control('restart'); } catch {} }
    throw new Error(`Could not apply changes; previous config restored. ${sanitize(error.message, old)}`);
  }
  return { message: wasRunning ? 'Saved and applied.' : 'Saved. Start the proxy when ready.' };
}
async function perform(action, input = {}) {
  if (action === 'credential.read') {
    const cfg = loadConfig();
    if (input.scope === 'proxy') return { value: cfg.accessRevoked ? '' : cfg.authToken || '', revoked: cfg.accessRevoked === true };
    if (input.scope !== 'provider' || !Object.hasOwn(cfg.upstreams, input.name)) throw new Error('Unknown channel');
    return { value: cfg.upstreams[input.name].apiKey || '' };
  }
  if (action === 'token.generate' || action === 'token.revoke') return serialize(async () => {
    const cfg = loadConfig();
    cfg.authToken = generateToken();
    cfg.accessRevoked = action === 'token.revoke';
    cfg.publicMode = true;
    await saveAndApply(cfg);
    return { message: cfg.accessRevoked ? 'Proxy key revoked. API access is blocked until you generate a new key.' : 'New proxy key generated. Previous keys are no longer valid.' };
  });
  if (action === 'provider.revoke') return serialize(async () => {
    const cfg = loadConfig();
    if (!Object.hasOwn(cfg.upstreams, input.name)) throw new Error('Unknown channel');
    delete cfg.upstreams[input.name].apiKey;
    cfg.upstreams[input.name].enabled = false;
    await saveAndApply(cfg);
    return { message: 'Stored key removed and channel disabled locally. Manage the key at the provider to revoke it there.' };
  });
  if (['start', 'stop', 'restart'].includes(action)) return serialize(() => control(action));
  if (action === 'provider.save') return serialize(async () => {
    const cfg = loadConfig(); const name = validateRouteName(input.name);
    const exists = Object.hasOwn(cfg.upstreams, name);
    if (!exists && ['constructor', 'prototype', '__proto__'].includes(name)) throw new Error('Reserved route name');
    const previous = exists ? cfg.upstreams[name] : {};
    const next = { ...previous, baseUrl: String(input.baseUrl || '').trim(),
      sanitizeSse: input.sanitizeSse !== false, injectSessionHeaders: input.injectSessionHeaders === true };
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    if (input.apiKey) next.apiKey = String(input.apiKey).trim();
    else if (input.clearKey === true) { delete next.apiKey; next.enabled = false; }
    const headers = input.headers === undefined ? (previous.headers || {}) : input.headers;
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('Headers must be a JSON object');
    next.headers = { ...headers };
    // Masked header values are never sent to the browser. Preserve them on save.
    for (const [k,v] of Object.entries(previous.headers || {})) {
      if (/auth|token|key|cookie|secret/i.test(k) && !Object.hasOwn(next.headers, k)) next.headers[k] = v;
    }
    if (input.stripBodyKeys !== undefined) next.stripBodyKeys = input.stripBodyKeys;
    if (input.heartbeatMs === '' || input.heartbeatMs === null) delete next.heartbeatMs;
    else if (input.heartbeatMs !== undefined) next.heartbeatMs = Number(input.heartbeatMs);
    cfg.upstreams[name] = next;
    return saveAndApply(cfg);
  });
  if (action === 'provider.delete') return serialize(async () => {
    const cfg = loadConfig();
    if (!Object.hasOwn(cfg.upstreams, input.name)) throw new Error('Unknown provider');
    if (input.name === cfg.defaultUpstream) throw new Error('Choose another default provider before deleting this one');
    if (Object.keys(cfg.upstreams).length <= 1) throw new Error('Keep at least one provider');
    delete cfg.upstreams[input.name]; return saveAndApply(cfg);
  });
  if (action === 'settings.save') return serialize(async () => {
    const cfg = loadConfig();
    if (cfg.accessRevoked && input.publicMode === false) throw new Error('Generate a new proxy key to restore API access first');
    for (const field of ['port', 'heartbeatMs', 'maxBodyBytes']) if (input[field] !== undefined) cfg[field] = Number(input[field]);
    for (const field of ['defaultUpstream', 'logLevel']) if (input[field] !== undefined) cfg[field] = input[field];
    if (typeof input.publicMode === 'boolean') cfg.publicMode = input.publicMode;
    return saveAndApply(cfg);
  });
  if (action === 'models' || action === 'test') {
    const cfg = loadConfig();
    if (!Object.hasOwn(cfg.upstreams, input.name)) throw new Error('Unknown provider');
    if (cfg.upstreams[input.name].enabled === false) throw new Error('This channel is disabled. Enable it in Channels first.');
    if (action === 'test' && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256)) throw new Error('Choose a model first');
    const result = action === 'models' ? await fetchModels(cfg.upstreams[input.name]) : await testModel(cfg.upstreams[input.name], input.model);
    // Never return raw provider responses; they can include account details or keys.
    return { ok: result.ok, status: result.status || null, kind: result.kind,
      latencyMs: result.latencyMs, models: result.models || [],
      reply: action === 'test' ? sanitize(result.reply, cfg).slice(0, 120) : undefined,
      message: result.ok ? 'Request complete.' : sanitize(result.text || result.error || result.kind, cfg) };
  }
  throw new Error('Unknown action');
}
module.exports = { getHistory, snapshot, perform, redactedConfig, sanitize, serviceInfo, serialize, saveAndApply };

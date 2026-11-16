'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CONFIG_PATH = process.env.UA_PROXY_CONFIG
  || path.join(__dirname, 'config.json');
const MIN_TOKEN_LENGTH = 32;
const ROUTE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isValidAuthToken(value) {
  return typeof value === 'string'
    && value.length >= MIN_TOKEN_LENGTH
    && value.length <= 256
    && !value.startsWith('REPLACE_')
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

function validateRouteName(name) {
  if (typeof name !== 'string' || !ROUTE_RE.test(name)) {
    throw new Error(`invalid upstream route "${name}"; use lowercase a-z, 0-9, _ or -`);
  }
  return name;
}

function validateConfig(config, { publicMode = config?.publicMode } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object');
  }
  if (!config.upstreams || typeof config.upstreams !== 'object'
      || Array.isArray(config.upstreams) || !Object.keys(config.upstreams).length) {
    throw new Error('config requires at least one upstream');
  }
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    validateRouteName(name);
    if (!upstream || typeof upstream !== 'object') {
      throw new Error(`upstream "${name}" must be an object`);
    }
    if (typeof upstream.baseUrl !== 'string' || !/^https?:\/\//i.test(upstream.baseUrl)) {
      throw new Error(`upstream "${name}" requires an http(s) baseUrl`);
    }
    const url = new URL(upstream.baseUrl);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl must not contain credentials, a query, or a fragment');
    }
    if (upstream.headers !== undefined) {
      for (const [header, value] of Object.entries(upstream.headers)) {
        if (!HEADER_NAME_RE.test(header) || ['__proto__', 'constructor', 'prototype'].includes(header)) {
          throw new Error(`upstream "${name}" has invalid header name`);
        }
        if (typeof value !== 'string' || /[\r\n]/.test(value)) {
          throw new Error(`upstream "${name}" has invalid header value`);
        }
      }
    }
  }
  if (config.defaultUpstream && !Object.hasOwn(config.upstreams, config.defaultUpstream)) {
    throw new Error(`defaultUpstream "${config.defaultUpstream}" is not defined`);
  }
  if (config.authToken && !isValidAuthToken(config.authToken)) {
    throw new Error(`authToken must be at least ${MIN_TOKEN_LENGTH} non-space characters`);
  }
  if (publicMode && !isValidAuthToken(config.authToken)) {
    throw new Error('publicMode requires a valid authToken');
  }
  if (typeof config.accessRevoked !== 'undefined' && typeof config.accessRevoked !== 'boolean') {
    throw new Error('accessRevoked must be boolean');
  }
  const active = Object.values(config.upstreams).filter(upstream => upstream.enabled !== false);
  if (publicMode && active.length && !active.some((upstream) => upstream.apiKey)) {
    throw new Error('publicMode requires at least one upstream apiKey');
  }
  if (config.port !== undefined
      && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  if (config.maxBodyBytes !== undefined
      && (!Number.isInteger(config.maxBodyBytes) || config.maxBodyBytes < 1024)) {
    throw new Error('maxBodyBytes must be an integer >= 1024');
  }
  if (config.heartbeatMs !== undefined
      && (!Number.isInteger(config.heartbeatMs) || config.heartbeatMs < 0)) {
    throw new Error('heartbeatMs must be an integer >= 0');
  }
  if (config.logLevel !== undefined && !['error', 'warn', 'info', 'debug'].includes(config.logLevel)) {
    throw new Error('logLevel must be error, warn, info, or debug');
  }
  if (config.host !== undefined && (typeof config.host !== 'string' || !config.host.trim())) {
    throw new Error('host must be a non-empty string');
  }
  if (config.host && !publicMode && !LOOPBACK_HOSTS.has(config.host)) {
    throw new Error('non-loopback host requires publicMode=true');
  }
  for (const upstream of Object.values(config.upstreams)) {
    if (upstream.apiKey !== undefined && typeof upstream.apiKey !== 'string') {
      throw new Error('upstream apiKey must be a string');
    }
    if (upstream.apiKey && /[\r\n]/.test(upstream.apiKey)) throw new Error('API key must not contain line breaks');
    if (upstream.headers !== undefined && (typeof upstream.headers !== 'object' || Array.isArray(upstream.headers))) {
      throw new Error('upstream headers must be an object');
    }
    if (upstream.stripBodyKeys !== undefined
        && (!Array.isArray(upstream.stripBodyKeys) || upstream.stripBodyKeys.some((key) => typeof key !== 'string'))) {
      throw new Error('stripBodyKeys must be an array of strings');
    }
    if (upstream.chatVia !== undefined
        && (typeof upstream.chatVia !== 'string' || !['responses', 'off'].includes(upstream.chatVia))) {
      throw new Error('chatVia must be "responses" or "off"');
    }
    for (const key of ['injectSessionHeaders', 'sanitizeSse', 'enabled']) {
      if (upstream[key] !== undefined && typeof upstream[key] !== 'boolean') {
        throw new Error(`upstream ${key} must be boolean`);
      }
    }
    if (upstream.heartbeatMs !== undefined
        && (!Number.isInteger(upstream.heartbeatMs) || upstream.heartbeatMs < 0)) {
      throw new Error('upstream heartbeatMs must be an integer >= 0');
    }
  }
  return config;
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return validateConfig(config);
}

function maskSecret(value) {
  if (!value) return '(not set)';
  const string = String(value);
  if (string.length <= 8) return '********';
  return `${string.slice(0, 3)}${'*'.repeat(Math.max(4, string.length - 7))}${string.slice(-4)}`;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function backupPath(configPath) {
  return `${configPath}.bak`;
}

function writeConfigAtomic(config, configPath = DEFAULT_CONFIG_PATH) {
  validateConfig(config, { publicMode: config.publicMode });
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(configPath)}.${process.pid}.tmp`);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  try {
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, backupPath(configPath));
      fs.chmodSync(backupPath(configPath), 0o600);
    }
    fs.writeFileSync(temporary, serialized, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function generateToken() {
  return `zpx_${crypto.randomBytes(32).toString('hex')}`;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  MIN_TOKEN_LENGTH,
  ROUTE_RE,
  cloneConfig,
  generateToken,
  isValidAuthToken,
  loadConfig,
  maskSecret,
  validateConfig,
  validateRouteName,
  writeConfigAtomic,
};

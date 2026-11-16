'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cloneConfig,
  generateToken,
  isValidAuthToken,
  loadConfig,
  maskSecret,
  validateRouteName,
  writeConfigAtomic,
} = require('./config-store.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-proxy-config-'));
const file = path.join(temp, 'config.json');
const config = {
  host: '127.0.0.1', port: 8787, publicMode: false, authToken: generateToken(),
  upstreams: { provider: { baseUrl: 'https://example.test/v1', apiKey: 'secret-key' } },
  defaultUpstream: 'provider',
};

assert.ok(isValidAuthToken(config.authToken));
assert.ok(!isValidAuthToken('REPLACE_WITH_LONG_RANDOM_TOKEN'));
assert.ok(maskSecret('sk-super-secret-key').includes('*'));
assert.strictEqual(maskSecret(''), '(not set)');
validateRouteName('provider_1');
assert.throws(() => validateRouteName('../bad'));

fs.writeFileSync(file, JSON.stringify({
  ...config,
  heartbeatMs: 'bad',
}));
assert.throws(() => loadConfig(file));

writeConfigAtomic(config, file);
assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
assert.deepStrictEqual(loadConfig(file), config);
assert.ok(fs.existsSync(`${file}.bak`));
assert.strictEqual(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);

const next = cloneConfig(config);
next.upstreams.foo = { baseUrl: 'https://foo.test/v1', apiKey: 'foo-key' };
writeConfigAtomic(next, file);
assert.strictEqual(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);
assert.strictEqual(loadConfig(file).upstreams.foo.apiKey, 'foo-key');
assert.strictEqual(loadConfig(file).upstreams.provider.apiKey, 'secret-key');

fs.rmSync(temp, { recursive: true, force: true });
console.log('config-store tests OK');

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nsKey, keyMatches, generateApiKey } from '../worker.js';
import { mockEnv } from './helpers.js';

test('nsKey: admin key uses un-prefixed name', () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.equal(nsKey('donations', 'ADMINKEY', env), 'donations');
});

test('nsKey: non-admin key is prefixed', () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.equal(nsKey('donations', 'abc123', env), 'donations:abc123');
});

test('keyMatches: admin key matches', () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.equal(keyMatches('ADMINKEY', env, []), true);
});

test('keyMatches: account key matches', () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.equal(keyMatches('k1', env, [{ apiKey: 'k1' }]), true);
});

test('keyMatches: unknown/empty key fails', () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.equal(keyMatches('nope', env, [{ apiKey: 'k1' }]), false);
  assert.equal(keyMatches('', env, []), false);
  assert.equal(keyMatches(null, env, []), false);
});

test('generateApiKey: unique vs existing keys and admin key', () => {
  const env = mockEnv({}, 'ADMINKEY');
  const accounts = [{ apiKey: 'k1' }, { apiKey: 'k2' }];
  const key = generateApiKey(accounts, env);
  assert.equal(typeof key, 'string');
  assert.ok(key.length >= 16);
  assert.ok(!['ADMINKEY', 'k1', 'k2'].includes(key));
});

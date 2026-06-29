import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAddAccount, handleListAccounts, handleDeleteAccount } from '../worker.js';
import { mockEnv, makeReq } from './helpers.js';

test('handleAddAccount: stores account with generated apiKey', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const res = await handleAddAccount(makeReq({ email: 'a@x', password: 'pass' }), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.apiKey, 'string');

  const accounts = JSON.parse(env._store.get('accounts'));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, 'a@x');
  assert.equal(accounts[0].password, 'pass');
  assert.equal(accounts[0].apiKey, body.apiKey);
});

test('handleAddAccount: rejects duplicate email', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'p', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await handleAddAccount(makeReq({ email: 'a@x', password: 'pass' }), env);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('handleListAccounts: returns email + apiKey, never password', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'secret', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await handleListAccounts(env);
  const body = await res.json();
  assert.deepEqual(body.data, [{ email: 'a@x', apiKey: 'k1' }]);
  assert.ok(!JSON.stringify(body).includes('secret'));
});

test('handleDeleteAccount: removes account and its data', async () => {
  const env = mockEnv({
    accounts: JSON.stringify([{ email: 'a@x', password: 'p', apiKey: 'k1' }]),
    'donations:k1': '[]',
    'leaderboard:k1': '[]',
    'tier_config:k1': '{}',
  }, 'ADMINKEY');
  const res = await handleDeleteAccount(makeReq({ email: 'a@x' }), env);
  assert.equal((await res.json()).ok, true);
  assert.equal(JSON.parse(env._store.get('accounts')).length, 0);
  assert.equal(env._store.has('donations:k1'), false);
  assert.equal(env._store.has('leaderboard:k1'), false);
  assert.equal(env._store.has('tier_config:k1'), false);
});

test('handleDeleteAccount: unknown email returns 404 and leaves accounts intact', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'p', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await handleDeleteAccount(makeReq({ email: 'nobody@x' }), env);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);
  assert.equal(JSON.parse(env._store.get('accounts')).length, 1);
});

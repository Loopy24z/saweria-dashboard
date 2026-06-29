import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLogin } from '../worker.js';
import { mockEnv, makeReq } from './helpers.js';

test('login: admin gets env API key + isAdmin', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const res = await handleLogin(makeReq({ email: 'admin@test', password: 'adminpass' }), env);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, key: body.key, isAdmin: body.isAdmin },
    { ok: true, key: 'ADMINKEY', isAdmin: true });
});

test('login: account gets its own apiKey + not admin', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'pass', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await handleLogin(makeReq({ email: 'a@x', password: 'pass' }), env);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, key: body.key, isAdmin: body.isAdmin },
    { ok: true, key: 'k1', isAdmin: false });
});

test('login: wrong credentials fail', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'pass', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await handleLogin(makeReq({ email: 'a@x', password: 'WRONG' }), env);
  assert.equal((await res.json()).ok, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook, getDonations } from '../worker.js';
import { mockEnv, makeReq } from './helpers.js';

test('webhook: account donation lands in account namespace only', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  await handleWebhook(makeReq({ donatur: 'Budi', amount_raw: 50000, pesan: 'hi' }), env, 'k1');

  const acctD  = await getDonations(env, 'k1');
  const adminD = await getDonations(env, 'ADMINKEY');
  assert.equal(acctD.length, 1);
  assert.equal(acctD[0].donor_name, 'Budi');
  assert.equal(adminD.length, 0); // admin namespace untouched
  assert.ok(env._store.has('leaderboard:k1'));
});

test('webhook: admin donation uses un-prefixed namespace', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  await handleWebhook(makeReq({ donatur: 'Ani', amount_raw: 10000 }), env, 'ADMINKEY');
  assert.equal((await getDonations(env, 'ADMINKEY')).length, 1);
  assert.equal(env._store.has('donations:ADMINKEY'), false);
});

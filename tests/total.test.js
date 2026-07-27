import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook, handleDelete, handleEditAmount, handleLeaderboard } from '../worker.js';
import { mockEnv, makeReq } from './helpers.js';

const don = (over = {}) => ({ id: Date.now(), donor_name: 'X', amount: 100, status: 'pending', message: '', created_at: 't', ...over });

test('total: a new donation adds to the all-time total, not recomputed from the capped list', async () => {
  const env = mockEnv({
    donations: JSON.stringify([don({ amount: 100 })]),
    stats:     JSON.stringify({ total: 8000 }),
  }, 'ADMINKEY');

  await handleWebhook(makeReq({ donatur: 'A', amount_raw: 5000 }), env, 'ADMINKEY');

  // 8000 + 5000. If it were summed from the donations list it would be 5100.
  assert.equal(JSON.parse(env._store.get('stats')).total, 13000);
});

test('total: cold start seeds from current donations then stays accurate', async () => {
  const env = mockEnv({
    donations: JSON.stringify([don({ amount: 3000 })]),
  }, 'ADMINKEY'); // no stats yet

  await handleWebhook(makeReq({ donatur: 'A', amount_raw: 2000 }), env, 'ADMINKEY');

  // donations now [2000, 3000] -> seeded total 5000
  assert.equal(JSON.parse(env._store.get('stats')).total, 5000);
});

test('leaderboard: response includes the running all-time total', async () => {
  const env = mockEnv({ stats: JSON.stringify({ total: 12345 }), leaderboard: JSON.stringify([]) }, 'ADMINKEY');
  const body = await (await handleLeaderboard(env, 'ADMINKEY')).json();
  assert.equal(body.total, 12345);
});

test('total: deleting a donation subtracts its amount', async () => {
  const env = mockEnv({
    donations: JSON.stringify([don({ id: 111, amount: 2000 })]),
    stats:     JSON.stringify({ total: 10000 }),
  }, 'ADMINKEY');

  await handleDelete('111', env, 'ADMINKEY');

  assert.equal(JSON.parse(env._store.get('stats')).total, 8000);
});

test('total: never goes negative', async () => {
  const env = mockEnv({
    donations: JSON.stringify([don({ id: 111, amount: 5000 })]),
    stats:     JSON.stringify({ total: 1000 }),
  }, 'ADMINKEY');

  await handleDelete('111', env, 'ADMINKEY');

  assert.equal(JSON.parse(env._store.get('stats')).total, 0);
});

test('total: editing a donation amount adjusts the total by the difference', async () => {
  const env = mockEnv({
    donations: JSON.stringify([don({ id: 222, amount: 2000 })]),
    stats:     JSON.stringify({ total: 10000 }),
  }, 'ADMINKEY');

  await handleEditAmount('222', makeReq({ amount: 3000 }), env, 'ADMINKEY');

  assert.equal(JSON.parse(env._store.get('stats')).total, 11000);
});

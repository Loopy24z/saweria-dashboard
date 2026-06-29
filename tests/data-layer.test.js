import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDonations, getConfig, updateLeaderboard } from '../worker.js';
import { mockEnv } from './helpers.js';

test('getDonations: admin reads un-prefixed key', async () => {
  const env = mockEnv({ donations: JSON.stringify([{ id: 1 }]) }, 'ADMINKEY');
  const d = await getDonations(env, 'ADMINKEY');
  assert.deepEqual(d, [{ id: 1 }]);
});

test('getDonations: account reads prefixed key, isolated from admin', async () => {
  const env = mockEnv({
    donations: JSON.stringify([{ id: 1 }]),
    'donations:k1': JSON.stringify([{ id: 99 }]),
  }, 'ADMINKEY');
  assert.deepEqual(await getDonations(env, 'k1'), [{ id: 99 }]);
});

test('getDonations: empty namespace returns []', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.deepEqual(await getDonations(env, 'k1'), []);
});

test('getConfig: unknown tenant falls back to DEFAULT_CONFIG', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const cfg = await getConfig(env, 'k1');
  assert.ok(Array.isArray(cfg.tiers));
});

test('updateLeaderboard: writes to tenant-prefixed key', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  await updateLeaderboard(env, [{ donor_name: 'A', amount: 5000 }], 'k1');
  const lb = JSON.parse(env._store.get('leaderboard:k1'));
  assert.equal(lb[0].donor_name, 'A');
  assert.equal(env._store.has('leaderboard'), false); // admin untouched
});

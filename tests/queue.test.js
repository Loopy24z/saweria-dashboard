import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleQueue, handleHistory, handleLeaderboard, handleGetConfig } from '../worker.js';
import { mockEnv } from './helpers.js';

function seedDonations(arr) { return JSON.stringify(arr); }

test('queue: returns only this tenant pending donations, then marks claimed', async () => {
  const env = mockEnv({
    'donations:k1': seedDonations([{ id: 1, donor_name: 'A', amount: 5000, status: 'pending', message: '', created_at: 't' }]),
    donations:      seedDonations([{ id: 2, donor_name: 'Z', amount: 9000, status: 'pending', message: '', created_at: 't' }]),
  }, 'ADMINKEY');

  const res = await handleQueue(env, 'k1');
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].donor_name, 'A');

  // tenant k1 marked claimed, admin untouched
  assert.equal(JSON.parse(env._store.get('donations:k1'))[0].status, 'claimed');
  assert.equal(JSON.parse(env._store.get('donations'))[0].status, 'pending');
});

test('history: reads this tenant donations only', async () => {
  const env = mockEnv({ 'donations:k1': seedDonations([{ id: 1 }]) }, 'ADMINKEY');
  const body = await (await handleHistory(env, 'k1')).json();
  assert.equal(body.data.length, 1);
});

test('leaderboard: reads this tenant board only', async () => {
  const env = mockEnv({ 'leaderboard:k1': JSON.stringify([{ donor_name: 'A', total_amount: 1 }]) }, 'ADMINKEY');
  const body = await (await handleLeaderboard(env, 'k1')).json();
  assert.equal(body.data[0].donor_name, 'A');
});

test('config: unknown tenant returns default tiers', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const body = await (await handleGetConfig(env, 'k1')).json();
  assert.ok(Array.isArray(body.tiers));
});

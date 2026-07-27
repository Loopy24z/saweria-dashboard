import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleQueue, handleHistory, handleLeaderboard, handleGetConfig } from '../worker.js';
import { mockEnv } from './helpers.js';

const seed = (arr) => JSON.stringify(arr);
const recentId = () => Date.now() - 1_000;        // within the delivery window
const oldId    = () => Date.now() - 10 * 60_000;  // 10 min ago, well outside the window

test('queue: delivers the same donation on repeated polls so every game server receives it', async () => {
  const env = mockEnv({
    'donations:k1': seed([{ id: recentId(), donor_name: 'A', amount: 5000, status: 'pending', message: '', created_at: 't' }]),
  }, 'ADMINKEY');

  const first  = await (await handleQueue(env, 'k1')).json();
  const second = await (await handleQueue(env, 'k1')).json();

  assert.equal(first.data.length, 1, 'first server poll receives the donation');
  assert.equal(second.data.length, 1, 'a second server polling still receives the same donation');
  assert.equal(second.data[0].donor_name, 'A');
});

test('queue: does not return donations older than the delivery window', async () => {
  const env = mockEnv({
    'donations:k1': seed([
      { id: recentId(), donor_name: 'New', amount: 1, status: 'pending', message: '', created_at: 't' },
      { id: oldId(),    donor_name: 'Old', amount: 1, status: 'pending', message: '', created_at: 't' },
    ]),
  }, 'ADMINKEY');

  const body = await (await handleQueue(env, 'k1')).json();
  assert.deepEqual(body.data.map((d) => d.donor_name), ['New']);
});

test('queue: does not mutate stored donations (no claim-once write)', async () => {
  const stored = seed([{ id: recentId(), donor_name: 'A', amount: 5000, status: 'pending', message: '', created_at: 't' }]);
  const env = mockEnv({ 'donations:k1': stored }, 'ADMINKEY');

  await handleQueue(env, 'k1');

  assert.equal(env._store.get('donations:k1'), stored, 'stored donations left untouched');
});

test('queue: returns only this tenant donations', async () => {
  const env = mockEnv({
    'donations:k1': seed([{ id: recentId(), donor_name: 'A', amount: 5000, status: 'pending', message: '', created_at: 't' }]),
    donations:      seed([{ id: recentId(), donor_name: 'Z', amount: 9000, status: 'pending', message: '', created_at: 't' }]),
  }, 'ADMINKEY');

  const body = await (await handleQueue(env, 'k1')).json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].donor_name, 'A');
});

test('history: reads this tenant donations only', async () => {
  const env = mockEnv({ 'donations:k1': seed([{ id: 1 }]) }, 'ADMINKEY');
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

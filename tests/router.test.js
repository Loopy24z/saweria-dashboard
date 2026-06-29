import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { mockEnv } from './helpers.js';

function req(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request('http://w.local' + path, init);
}

test('router: unknown webhook key -> 401', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const res = await worker.fetch(req('POST', '/webhook/bogus', { donatur: 'X', amount_raw: 1000 }), env);
  assert.equal(res.status, 401);
});

test('router: unknown ?key= on /queue -> 401', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const res = await worker.fetch(req('GET', '/queue?key=bogus'), env);
  assert.equal(res.status, 401);
});

test('router: non-admin account key on /accounts -> 403', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'p', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await worker.fetch(req('GET', '/accounts?key=k1&admin=a@x'), env);
  assert.equal(res.status, 403);
});

test('router: admin key + admin email on /accounts -> 200 with apiKey', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'p', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await worker.fetch(req('GET', '/accounts?key=ADMINKEY&admin=admin@test'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data[0].apiKey, 'k1');
});

test('router: end-to-end tenant isolation webhook -> history', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'a@x', password: 'p', apiKey: 'k1' }]) }, 'ADMINKEY');
  await worker.fetch(req('POST', '/webhook/k1', { donatur: 'Budi', amount_raw: 50000 }), env);
  const acctHist = await (await worker.fetch(req('GET', '/history?key=k1'), env)).json();
  assert.equal(acctHist.data.length, 1);
  assert.equal(acctHist.data[0].donor_name, 'Budi');
  const adminHist = await (await worker.fetch(req('GET', '/history?key=ADMINKEY'), env)).json();
  assert.equal(adminHist.data.length, 0);
});

test('router: OPTIONS preflight returns 200 with CORS', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const res = await worker.fetch(req('OPTIONS', '/queue'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

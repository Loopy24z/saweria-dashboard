# Multi-Tenant Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Cloudflare Worker serve many accounts, each with its own auto-generated API key and isolated donation data, while preserving the existing admin account and its data.

**Architecture:** Each KV record is namespaced per tenant by prefixing the key with the tenant's API key (`donations:<key>`, `leaderboard:<key>`, `tier_config:<key>`). The admin tenant (`key === env.API_KEY`) keeps the existing un-prefixed keys for backward compatibility. A small set of pure helpers (`nsKey`, `keyMatches`, `generateApiKey`) plus async resolvers (`isValidKey`, `resolveTenantKey`) route every request to the right namespace.

**Tech Stack:** Cloudflare Workers (ESM, `export default { fetch }`), Workers KV, vanilla JS dashboard (`index.html`). Tests use Node's built-in test runner (`node --test`) with an in-memory KV mock — no external dependencies.

## Global Constraints

- Node.js **>= 20** required to run tests (uses global `crypto.randomUUID`, `Request`, `Response`).
- Admin tenant (`key === env.API_KEY`) MUST keep using un-prefixed KV keys (`donations`, `leaderboard`, `tier_config`) — no data migration, no data loss.
- API keys are **auto-generated once** per account and never regenerated.
- Account management endpoints (`/accounts*`) stay **admin-only** (`isAdmin` gate).
- Passwords are never returned to the frontend.
- Each new account starts from `DEFAULT_CONFIG` for its tier config.

---

### Task 1: Tenant helpers + test harness

**Files:**
- Modify: `worker.js` (add tenant helpers near `authKey`, worker.js:26-27)
- Create: `package.json`
- Create: `tests/helpers.js` (shared mock utilities)
- Test: `tests/tenant-helpers.test.js`

**Interfaces:**
- Produces:
  - `nsKey(prefix: string, key: string, env: {API_KEY}) -> string`
  - `keyMatches(key: string, env: {API_KEY}, accounts: {apiKey}[]) -> boolean`
  - `generateApiKey(accounts: {apiKey}[], env: {API_KEY}) -> string` (32-char hex, unique vs all account keys and `env.API_KEY`)
  - `isValidKey(key, env) -> Promise<boolean>` (reads KV accounts)
  - `resolveTenantKey(url: URL, env) -> Promise<string|null>` (reads `?key=`, returns validated key or null)
  - Test mock: `mockEnv(seed?, apiKey?)`, `makeReq(bodyObj)` from `tests/helpers.js`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "saweria-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `tests/helpers.js`**

```js
// In-memory KV + Request mocks for unit testing the worker.
export function mockEnv(seed = {}, apiKey = 'ADMINKEY') {
  const store = new Map(Object.entries(seed));
  return {
    API_KEY: apiKey,
    ADMIN_EMAIL: 'admin@test',
    ADMIN_PASS: 'adminpass',
    _store: store,
    DB: {
      get:    async (k) => (store.has(k) ? store.get(k) : null),
      put:    async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
}

export function makeReq(body) {
  return new Request('http://test.local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 3: Write the failing test** — `tests/tenant-helpers.test.js`

```js
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — `SyntaxError: ... does not provide an export named 'nsKey'` (or import error), because the helpers do not exist yet.

- [ ] **Step 5: Implement the helpers in `worker.js`**

Insert immediately after the `isAdmin` definition (worker.js:27):

```js
// ── Tenant routing helpers ───────────────────────────────────────────────
export function nsKey(prefix, key, env) {
  return key === env.API_KEY ? prefix : `${prefix}:${key}`;
}

export function keyMatches(key, env, accounts) {
  if (!key) return false;
  if (key === env.API_KEY) return true;
  return accounts.some(a => a.apiKey === key);
}

export function generateApiKey(accounts, env) {
  const existing = new Set([env.API_KEY, ...accounts.map(a => a.apiKey)]);
  let key;
  do { key = crypto.randomUUID().replace(/-/g, ''); } while (existing.has(key));
  return key;
}

async function isValidKey(key, env) {
  return keyMatches(key, env, await getAccounts(env));
}

async function resolveTenantKey(url, env) {
  const key = url.searchParams.get('key');
  return (await isValidKey(key, env)) ? key : null;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test`
Expected: PASS — all `tenant-helpers.test.js` tests green.

- [ ] **Step 7: Commit**

```bash
git add package.json tests/helpers.js tests/tenant-helpers.test.js worker.js
git commit -m "feat: add tenant routing helpers + test harness"
```

---

### Task 2: Per-tenant data access layer

**Files:**
- Modify: `worker.js` — `getDonations` (worker.js:304-307), `getConfig` (worker.js:332-335), `updateLeaderboard` (worker.js:346-356)
- Test: `tests/data-layer.test.js`

**Interfaces:**
- Consumes: `nsKey` (Task 1)
- Produces:
  - `getDonations(env, key) -> Promise<Donation[]>`
  - `getConfig(env, key) -> Promise<Config>`
  - `updateLeaderboard(env, donations, key) -> Promise<void>`

- [ ] **Step 1: Write the failing test** — `tests/data-layer.test.js`

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — `getDonations` etc. are not exported yet / signatures don't accept `key`.

- [ ] **Step 3: Update `getDonations` (worker.js:304-307)**

```js
export async function getDonations(env, key) {
  const raw = await env.DB.get(nsKey('donations', key, env));
  return raw ? JSON.parse(raw) : [];
}
```

- [ ] **Step 4: Update `getConfig` (worker.js:332-335)**

```js
export async function getConfig(env, key) {
  const raw = await env.DB.get(nsKey('tier_config', key, env));
  return raw ? JSON.parse(raw) : DEFAULT_CONFIG;
}
```

- [ ] **Step 5: Update `updateLeaderboard` (worker.js:346-356)**

```js
export async function updateLeaderboard(env, donations, key) {
  const totals = {};
  for (const d of donations) {
    totals[d.donor_name] = (totals[d.donor_name] || 0) + (Number(d.amount) || 0);
  }
  const lb = Object.entries(totals)
    .map(([donor_name, total_amount]) => ({ donor_name, total_amount }))
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, 20);
  await env.DB.put(nsKey('leaderboard', key, env), JSON.stringify(lb));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test`
Expected: PASS — all of `data-layer.test.js` green. (`tenant-helpers.test.js` still green.)

- [ ] **Step 7: Commit**

```bash
git add worker.js tests/data-layer.test.js
git commit -m "feat: namespace donation/config/leaderboard data per tenant"
```

---

### Task 3: Account management (generate key, list with key, purge on delete)

**Files:**
- Modify: `worker.js` — `handleAddAccount` (worker.js:272-288), `handleListAccounts` (worker.js:266-270), `handleDeleteAccount` (worker.js:290-301)
- Test: `tests/accounts.test.js`

**Interfaces:**
- Consumes: `getAccounts` (worker.js:261), `generateApiKey`, `nsKey` (Task 1)
- Produces:
  - `handleAddAccount(request, env) -> Response` — stores `{ email, password, apiKey }`, returns `{ ok:true, apiKey }`
  - `handleListAccounts(env) -> Response` — returns `{ data: {email, apiKey}[] }`
  - `handleDeleteAccount(request, env) -> Response` — removes account + its `donations:/leaderboard:/tier_config:` keys

- [ ] **Step 1: Write the failing test** — `tests/accounts.test.js`

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — list returns only `{email}`, add does not generate `apiKey`, delete does not purge data.

- [ ] **Step 3: Update `handleAddAccount` (worker.js:272-288)**

```js
export async function handleAddAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return fail('Email dan password wajib diisi');
  if (password.length < 4) return fail('Password minimal 4 karakter');

  const accounts = await getAccounts(env);
  if (accounts.find(a => a.email === email)) {
    return json({ ok: false, error: 'Email sudah terdaftar' }, 400);
  }

  const apiKey = generateApiKey(accounts, env);
  accounts.push({ email, password, apiKey });
  await env.DB.put('accounts', JSON.stringify(accounts));
  return json({ ok: true, apiKey });
}
```

- [ ] **Step 4: Update `handleListAccounts` (worker.js:266-270)**

```js
export async function handleListAccounts(env) {
  const accounts = await getAccounts(env);
  // Jangan kirim password ke frontend
  return json({ data: accounts.map(a => ({ email: a.email, apiKey: a.apiKey })) });
}
```

- [ ] **Step 5: Update `handleDeleteAccount` (worker.js:290-301)**

```js
export async function handleDeleteAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email } = body;
  if (!email) return fail('Email wajib diisi');

  const accounts = await getAccounts(env);
  const acct = accounts.find(a => a.email === email);
  const filtered = accounts.filter(a => a.email !== email);
  await env.DB.put('accounts', JSON.stringify(filtered));

  if (acct?.apiKey) {
    await env.DB.delete(nsKey('donations', acct.apiKey, env));
    await env.DB.delete(nsKey('leaderboard', acct.apiKey, env));
    await env.DB.delete(nsKey('tier_config', acct.apiKey, env));
  }
  return json({ ok: true });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test`
Expected: PASS — all of `accounts.test.js` green.

- [ ] **Step 7: Commit**

```bash
git add worker.js tests/accounts.test.js
git commit -m "feat: auto-generate per-account API key + purge data on delete"
```

---

### Task 4: Login returns the account's own API key

**Files:**
- Modify: `worker.js` — `handleLogin` (worker.js:239-258)
- Test: `tests/login.test.js`

**Interfaces:**
- Consumes: `getAccounts` (worker.js:261)
- Produces: `handleLogin(request, env) -> Response` — admin → `{ ok, key: env.API_KEY, isAdmin: true }`; account → `{ ok, key: account.apiKey, isAdmin: false }`

- [ ] **Step 1: Write the failing test** — `tests/login.test.js`

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — account branch currently returns `env.API_KEY` instead of `found.apiKey`, and `handleLogin` is not exported.

- [ ] **Step 3: Update `handleLogin` (worker.js:239-258)**

Change the export and the account branch (worker.js:252-255):

```js
export async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email, password } = body;

  // Cek akun utama (env vars) — admin
  if (email === env.ADMIN_EMAIL && password === env.ADMIN_PASS) {
    return json({ ok: true, key: env.API_KEY, isAdmin: true });
  }

  // Cek akun tambahan (KV) — bukan admin, pakai apiKey sendiri
  const accounts = await getAccounts(env);
  const found = accounts.find(a => a.email === email && a.password === password);
  if (found) {
    return json({ ok: true, key: found.apiKey, isAdmin: false });
  }

  return json({ ok: false, error: 'Email atau password salah' }, 401);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test`
Expected: PASS — all of `login.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add worker.js tests/login.test.js
git commit -m "feat: login returns each account's own API key"
```

---

### Task 5: Webhook routes donations to the owning tenant

**Files:**
- Modify: `worker.js` — webhook router branch (worker.js:38-42) and `handleWebhook` (worker.js:125-156)
- Test: `tests/webhook.test.js`

**Interfaces:**
- Consumes: `isValidKey` (Task 1), `getConfig`, `getDonations`, `updateLeaderboard` (Task 2)
- Produces: `handleWebhook(request, env, key) -> Response` — appends a donation into `nsKey('donations', key, env)` and updates that tenant's leaderboard

- [ ] **Step 1: Write the failing test** — `tests/webhook.test.js`

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — `handleWebhook` is not exported and ignores the `key` argument (writes to global `donations`).

- [ ] **Step 3: Update `handleWebhook` (worker.js:125-156)**

```js
export async function handleWebhook(request, env, key) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  console.log('[webhook] body keys:', Object.keys(body).join(','));
  console.log('[webhook] body:', JSON.stringify(body));

  const name   = body.donatur || body.donator_name || body.donor_name || body.name || 'Anonymous';
  const amount = Number(body.amount_raw ?? body.nominal ?? body.amount ?? 0);
  const msg    = body.pesan || body.message || '';
  const time   = body.created_at || body.created_on || body.paid_at || new Date().toISOString();

  if (!amount) return fail('No amount: ' + JSON.stringify(body));

  const cfg       = await getConfig(env, key);
  const level     = levelForAmount(amount, cfg.tiers);
  const donations = await getDonations(env, key);
  donations.unshift({
    id:         Date.now(),
    donor_name: name,
    amount,
    level,
    message:    msg,
    status:     'pending',
    created_at: time,
  });

  if (donations.length > 100) donations.splice(100);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await updateLeaderboard(env, donations, key);
  return json({ ok: true });
}
```

- [ ] **Step 4: Update the webhook router branch (worker.js:38-42)**

```js
    // POST /webhook/{key}  ← Saweria kirim donasi ke sini (admin atau akun)
    const wh = path.match(/^\/webhook\/(.+)$/);
    if (wh && method === 'POST') {
      const key = wh[1];
      if (!(await isValidKey(key, env))) return fail('Unauthorized', 401);
      return handleWebhook(request, env, key);
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test`
Expected: PASS — all of `webhook.test.js` green.

- [ ] **Step 6: Commit**

```bash
git add worker.js tests/webhook.test.js
git commit -m "feat: route incoming webhook donations to the owning tenant"
```

---

### Task 6: Per-tenant routing for queue/leaderboard/history/edit/delete/config

**Files:**
- Modify: `worker.js` — router branches (worker.js:44-118), and handlers `handleQueue` (159-173), `handleLeaderboard` (176-179), `handleHistory` (182-185), `handleDelete` (188-196), `handleEditAmount` (199-219), `handleTestNotif` (222-236), `handleGetConfig` (320-323), `handleSetConfig` (325-330). Remove now-unused `authKey` (worker.js:26).
- Test: `tests/queue.test.js`

**Interfaces:**
- Consumes: `resolveTenantKey` (Task 1), `getDonations`, `updateLeaderboard` (Task 2), `nsKey` (Task 1)
- Produces: all listed handlers take a trailing `key` argument and operate on that tenant's namespace.

- [ ] **Step 1: Write the failing test** — `tests/queue.test.js`

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — handlers not exported and ignore `key` (read global `donations`).

- [ ] **Step 3: Update the handlers in `worker.js`**

`handleQueue` (worker.js:159-173):

```js
export async function handleQueue(env, key) {
  const donations = await getDonations(env, key);
  const pending   = donations.filter(d => d.status === 'pending');

  for (const d of donations) {
    if (d.status === 'pending') d.status = 'claimed';
  }
  if (pending.length) await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));

  return json({
    data: pending.map(({ id, donor_name, amount, message, created_at }) => ({
      id, donor_name, donorName: donor_name, amount, message, created_at,
    })),
  });
}
```

`handleLeaderboard` (worker.js:176-179):

```js
export async function handleLeaderboard(env, key) {
  const raw = await env.DB.get(nsKey('leaderboard', key, env));
  return json({ data: raw ? JSON.parse(raw) : [] });
}
```

`handleHistory` (worker.js:182-185):

```js
export async function handleHistory(env, key) {
  const donations = await getDonations(env, key);
  return json({ data: donations });
}
```

`handleDelete` (worker.js:188-196):

```js
async function handleDelete(id, env, key) {
  const donations = await getDonations(env, key);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return fail('Not found', 404);
  donations.splice(idx, 1);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await updateLeaderboard(env, donations, key);
  return json({ ok: true });
}
```

`handleEditAmount` (worker.js:199-219) — change signature and the two writes:

```js
async function handleEditAmount(id, request, env, key) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const donations = await getDonations(env, key);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return fail('Not found', 404);

  if (body.amount !== undefined) {
    const newAmount = Number(body.amount);
    if (!newAmount || newAmount <= 0) return fail('Amount tidak valid');
    donations[idx].amount = newAmount;
  }
  if (body.donor_name !== undefined && body.donor_name.trim()) {
    donations[idx].donor_name = body.donor_name.trim();
  }

  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await updateLeaderboard(env, donations, key);
  return json({ ok: true });
}
```

`handleTestNotif` (worker.js:222-236):

```js
async function handleTestNotif(env, key) {
  const donations = await getDonations(env, key);
  donations.unshift({
    id:         Date.now(),
    donor_name: 'TestDonor',
    amount:     25000,
    message:    'Test notification dari dashboard',
    status:     'pending',
    created_at: new Date().toISOString(),
  });
  if (donations.length > 100) donations.splice(100);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await updateLeaderboard(env, donations, key);
  return json({ ok: true });
}
```

`handleGetConfig` (worker.js:320-323):

```js
export async function handleGetConfig(env, key) {
  const raw = await env.DB.get(nsKey('tier_config', key, env));
  return json(raw ? JSON.parse(raw) : DEFAULT_CONFIG);
}
```

`handleSetConfig` (worker.js:325-330):

```js
async function handleSetConfig(request, env, key) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }
  await env.DB.put(nsKey('tier_config', key, env), JSON.stringify(body));
  return json({ ok: true });
}
```

- [ ] **Step 4: Update the router branches (worker.js:44-118)**

Replace every `if (!authKey(url, env)) return fail('Unauthorized', 401);` data branch with a tenant-resolving version. Full replacement for worker.js:44-118:

```js
    // GET /queue?key=  ← Roblox ambil donasi pending
    if (path === '/queue' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleQueue(env, key);
    }

    // GET /leaderboard?key=
    if (path === '/leaderboard' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleLeaderboard(env, key);
    }

    // GET /history?key=
    if (path === '/history' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleHistory(env, key);
    }

    // POST /history/{id}/delete?key=
    const del = path.match(/^\/history\/(\d+)\/delete$/);
    if (del && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleDelete(del[1], env, key);
    }

    // POST /history/{id}/edit?key=  ← edit amount/nama donasi
    const edit = path.match(/^\/history\/(\d+)\/edit$/);
    if (edit && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleEditAmount(edit[1], request, env, key);
    }

    // POST /test-notification?key=
    if (path === '/test-notification' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleTestNotif(env, key);
    }

    // POST /api/login  ← dashboard login
    if (path === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }

    // GET /accounts?key=  ← list akun (admin only)
    if (path === '/accounts' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (!isAdmin(url, env)) return fail('Admin only', 403);
      return handleListAccounts(env);
    }

    // POST /accounts?key=  ← tambah akun (admin only)
    if (path === '/accounts' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (!isAdmin(url, env)) return fail('Admin only', 403);
      return handleAddAccount(request, env);
    }

    // POST /accounts/delete?key=  ← hapus akun (admin only)
    if (path === '/accounts/delete' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (!isAdmin(url, env)) return fail('Admin only', 403);
      return handleDeleteAccount(request, env);
    }

    // GET /config?key=  ← ambil tier config (Roblox & dashboard)
    if (path === '/config' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleGetConfig(env, key);
    }

    // POST /config?key=  ← simpan tier config dari dashboard
    if (path === '/config' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleSetConfig(request, env, key);
    }
```

- [ ] **Step 5: Remove the now-unused `authKey` helper (worker.js:26)**

Delete the line:

```js
const authKey = (url, env) => url.searchParams.get('key') === env.API_KEY;
```

(Keep `isAdmin` — still used by the `/accounts` branches.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test`
Expected: PASS — all test files green (`queue.test.js` plus the earlier suites).

- [ ] **Step 7: Commit**

```bash
git add worker.js tests/queue.test.js
git commit -m "feat: route queue/history/leaderboard/config/edit per tenant"
```

---

### Task 7: Dashboard shows each account's API key

**Files:**
- Modify: `index.html` — `loadAccounts` render block (index.html:804-808)

**Interfaces:**
- Consumes: `/accounts` now returns `{ email, apiKey }[]` (Task 3); `esc` helper (existing in index.html)
- Produces: account list rows display the email and the apiKey.

- [ ] **Step 1: Update the `loadAccounts` render block (index.html:804-808)**

```js
    list.innerHTML = accounts.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px">
        <div style="min-width:0">
          <div style="font-size:0.85rem">${esc(a.email)}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);font-family:monospace;word-break:break-all">${esc(a.apiKey || '—')}</div>
        </div>
        <button class="btn sm danger" onclick="deleteAccount('${esc(a.email)}',this)">Hapus</button>
      </div>`).join('');
```

- [ ] **Step 2: Manual verification**

Run the dashboard against the worker (see Task 8 to start it). Log in as admin → open Account Management → confirm each added account shows its email with the API key underneath, and Hapus still works.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: show per-account API key in dashboard account list"
```

---

### Task 8: Full-suite + local integration smoke test

**Files:**
- Create: `.dev.vars` (local-only secrets for `wrangler dev`; do NOT commit)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the entire unit suite**

Run: `node --test`
Expected: PASS — all tests across `tests/*.test.js` green, 0 failures.

- [ ] **Step 2: Create `.dev.vars` for local run** (not committed)

```
API_KEY=ADMINKEY
ADMIN_EMAIL=admin@test
ADMIN_PASS=adminpass
```

- [ ] **Step 3: Start the worker locally**

Run: `npx wrangler dev`
Expected: serves on `http://localhost:8787` with local KV.

- [ ] **Step 4: Smoke test tenant isolation with curl**

```bash
# admin login
curl -s -X POST localhost:8787/api/login -H 'content-type: application/json' -d '{"email":"admin@test","password":"adminpass"}'
# add an account (admin key + admin email)
curl -s -X POST 'localhost:8787/accounts?key=ADMINKEY&admin=admin@test' -H 'content-type: application/json' -d '{"email":"streamer@x","password":"pass"}'
# -> note the returned "apiKey" (call it K). Send a donation to that tenant:
curl -s -X POST localhost:8787/webhook/K -H 'content-type: application/json' -d '{"donatur":"Budi","amount_raw":50000}'
# tenant K sees it:
curl -s 'localhost:8787/history?key=K'
# admin does NOT see it:
curl -s 'localhost:8787/history?key=ADMINKEY'
```

Expected: the `streamer@x` donation appears only under `?key=K`, never under the admin key. An unknown key (`?key=bogus`) returns `Unauthorized` (401).

- [ ] **Step 5: Confirm `.dev.vars` is ignored**

Add `.dev.vars` to `.gitignore` if not already ignored, then verify:

Run: `git status --porcelain`
Expected: `.dev.vars` does NOT appear as an untracked file to be committed.

- [ ] **Step 6: Final commit (if `.gitignore` changed)**

```bash
git add .gitignore
git commit -m "chore: ignore local .dev.vars"
```

---

## Self-Review Notes

- **Spec coverage:** account model w/ apiKey (Task 3) ✓; admin = special tenant via `nsKey` (Tasks 1-2) ✓; tier config per account (Tasks 2,6) ✓; prefix namespacing Opsi 1 (Task 1) ✓; login returns own key (Task 4) ✓; webhook routing + 401 on unknown key (Task 5) ✓; queue/leaderboard/history/delete/edit/test-notif/config per tenant (Task 6) ✓; account list shows apiKey, delete purges data (Tasks 3,7) ✓; admin-only account mgmt preserved (Task 6 router) ✓; out-of-scope items excluded ✓.
- **Type consistency:** handler signatures end with `key`; `nsKey(prefix, key, env)`, `keyMatches(key, env, accounts)`, `generateApiKey(accounts, env)` used identically across tasks; `/accounts` payload `{email, apiKey}` matches frontend consumption in Task 7.
- **No placeholders:** every code/test step contains complete code and exact run commands.

/**
 * Saweria Donation Worker — loofyjo24
 *
 * Environment variables (set di Cloudflare dashboard → Workers → Settings → Variables):
 *   API_KEY      — secret key untuk Saweria webhook & Roblox queue
 *   ADMIN_EMAIL  — email login dashboard
 *   ADMIN_PASS   — password login dashboard
 *   DB           — KV namespace binding (buat KV namespace bernama "DB")
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const fail = (msg, status = 400) =>
  new Response(msg, { status, headers: CORS });

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
  if (!key) return false;
  if (key === env.API_KEY) return true;
  return keyMatches(key, env, await getAccounts(env));
}

async function resolveTenantKey(url, env) {
  const key = url.searchParams.get('key');
  return (await isValidKey(key, env)) ? key : null;
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // POST /webhook/{key}  ← Saweria kirim donasi ke sini (admin atau akun)
    const wh = path.match(/^\/webhook\/(.+)$/);
    if (wh && method === 'POST') {
      const key = wh[1];
      if (!(await isValidKey(key, env))) return fail('Unauthorized', 401);
      return handleWebhook(request, env, key);
    }

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
      if (key !== env.API_KEY) return fail('Admin only', 403);
      return handleListAccounts(env);
    }

    // POST /accounts?key=  ← tambah akun (admin only)
    if (path === '/accounts' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (key !== env.API_KEY) return fail('Admin only', 403);
      return handleAddAccount(request, env);
    }

    // POST /accounts/delete?key=  ← hapus akun (admin only)
    if (path === '/accounts/delete' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (key !== env.API_KEY) return fail('Admin only', 403);
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

    return fail('Not Found', 404);
  },
};

// ── Webhook ────────────────────────────────────────────────────────────
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

// ── Queue ──────────────────────────────────────────────────────────────
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

// ── Leaderboard ────────────────────────────────────────────────────────
export async function handleLeaderboard(env, key) {
  const raw = await env.DB.get(nsKey('leaderboard', key, env));
  return json({ data: raw ? JSON.parse(raw) : [] });
}

// ── History ────────────────────────────────────────────────────────────
export async function handleHistory(env, key) {
  const donations = await getDonations(env, key);
  return json({ data: donations });
}

// ── Delete ─────────────────────────────────────────────────────────────
async function handleDelete(id, env, key) {
  const donations = await getDonations(env, key);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return fail('Not found', 404);
  donations.splice(idx, 1);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await updateLeaderboard(env, donations, key);
  return json({ ok: true });
}

// ── Edit Entry ─────────────────────────────────────────────────────────
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

// ── Test Notif ─────────────────────────────────────────────────────────
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

// ── Login ──────────────────────────────────────────────────────────────
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

// ── Accounts ───────────────────────────────────────────────────────────
export async function getAccounts(env) {
  const raw = await env.DB.get('accounts');
  const accounts = raw ? JSON.parse(raw) : [];
  let changed = false;
  for (const a of accounts) {
    if (!a.apiKey) { a.apiKey = generateApiKey(accounts, env); changed = true; }
  }
  if (changed) await env.DB.put('accounts', JSON.stringify(accounts));
  return accounts;
}

export async function handleListAccounts(env) {
  const accounts = await getAccounts(env);
  // Jangan kirim password ke frontend
  return json({ data: accounts.map(a => ({ email: a.email, apiKey: a.apiKey })) });
}

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

export async function handleDeleteAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email } = body;
  if (!email) return fail('Email wajib diisi');

  const accounts = await getAccounts(env);
  const acct = accounts.find(a => a.email === email);
  if (!acct) return json({ ok: false, error: 'Akun tidak ditemukan' }, 404);
  const filtered = accounts.filter(a => a.email !== email);
  await env.DB.put('accounts', JSON.stringify(filtered));

  if (acct?.apiKey) {
    await env.DB.delete(nsKey('donations', acct.apiKey, env));
    await env.DB.delete(nsKey('leaderboard', acct.apiKey, env));
    await env.DB.delete(nsKey('tier_config', acct.apiKey, env));
  }
  return json({ ok: true });
}

// ── Helpers ────────────────────────────────────────────────────────────
export async function getDonations(env, key) {
  const raw = await env.DB.get(nsKey('donations', key, env));
  return raw ? JSON.parse(raw) : [];
}

// ── Config ─────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  tiers: [
    { name: 'Kilat',   minRp: 1,       level: 1, effect: 'Partikel',           color: '#6b7194' },
    { name: 'Api',     minRp: 50000,   level: 4, effect: 'Nuke',               color: '#f97316' },
    { name: 'Badai',   minRp: 150000,  level: 6, effect: 'Spesial',            color: '#a855f7' },
    { name: 'Legenda', minRp: 500000,  level: 7, effect: 'Blackhole + Hammer', color: '#00d4c8' },
  ],
  effectMinRp: { Nuke: 50000, Hammer: 500000, Blackhole: 1000000 },
};

export async function handleGetConfig(env, key) {
  const raw = await env.DB.get(nsKey('tier_config', key, env));
  return json(raw ? JSON.parse(raw) : DEFAULT_CONFIG);
}

async function handleSetConfig(request, env, key) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }
  await env.DB.put(nsKey('tier_config', key, env), JSON.stringify(body));
  return json({ ok: true });
}

export async function getConfig(env, key) {
  const raw = await env.DB.get(nsKey('tier_config', key, env));
  return raw ? JSON.parse(raw) : DEFAULT_CONFIG;
}

function levelForAmount(amount, tiers) {
  const sorted = [...tiers].sort((a, b) => b.minRp - a.minRp);
  for (const t of sorted) {
    if (amount >= t.minRp) return t.level || 1;
  }
  return 0;
}

// ── Leaderboard helper ─────────────────────────────────────────────────
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

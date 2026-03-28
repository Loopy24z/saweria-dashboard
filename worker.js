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

const authKey = (url, env) => url.searchParams.get('key') === env.API_KEY;
const isAdmin = (url, env) => url.searchParams.get('admin') === env.ADMIN_EMAIL;

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // POST /webhook/{API_KEY}  ← Saweria kirim donasi ke sini
    const wh = path.match(/^\/webhook\/(.+)$/);
    if (wh && method === 'POST') {
      if (wh[1] !== env.API_KEY) return fail('Unauthorized', 401);
      return handleWebhook(request, env);
    }

    // GET /queue?key=  ← Roblox ambil donasi pending
    if (path === '/queue' && method === 'GET') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleQueue(env);
    }

    // GET /leaderboard?key=
    if (path === '/leaderboard' && method === 'GET') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleLeaderboard(env);
    }

    // GET /history?key=
    if (path === '/history' && method === 'GET') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleHistory(env);
    }

    // POST /history/{id}/delete?key=
    const del = path.match(/^\/history\/(\d+)\/delete$/);
    if (del && method === 'POST') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleDelete(del[1], env);
    }

    // POST /history/{id}/edit?key=  ← edit amount donasi
    const edit = path.match(/^\/history\/(\d+)\/edit$/);
    if (edit && method === 'POST') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleEditAmount(edit[1], request, env);
    }

    // POST /test-notification?key=
    if (path === '/test-notification' && method === 'POST') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleTestNotif(env);
    }

    // POST /api/login  ← dashboard login
    if (path === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }

    // GET /accounts?key=  ← list akun (admin only)
    if (path === '/accounts' && method === 'GET') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      if (!isAdmin(url, env)) return fail('Admin only', 403);
      return handleListAccounts(env);
    }

    // POST /accounts?key=  ← tambah akun (admin only)
    if (path === '/accounts' && method === 'POST') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      if (!isAdmin(url, env)) return fail('Admin only', 403);
      return handleAddAccount(request, env);
    }

    // POST /accounts/delete?key=  ← hapus akun (admin only)
    if (path === '/accounts/delete' && method === 'POST') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      if (!isAdmin(url, env)) return fail('Admin only', 403);
      return handleDeleteAccount(request, env);
    }

    // GET /config?key=  ← ambil tier config (Roblox & dashboard)
    if (path === '/config' && method === 'GET') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleGetConfig(env);
    }

    // POST /config?key=  ← simpan tier config dari dashboard
    if (path === '/config' && method === 'POST') {
      if (!authKey(url, env)) return fail('Unauthorized', 401);
      return handleSetConfig(request, env);
    }

    return fail('Not Found', 404);
  },
};

// ── Webhook ────────────────────────────────────────────────────────────
async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const name   = body.donatur || body.donor_name || body.name || 'Anonymous';
  const amount = Number(body.nominal || body.amount || 0);
  const msg    = body.pesan || body.message || '';
  const time   = body.created_on || new Date().toISOString();

  if (!amount) return fail('No amount');

  const cfg       = await getConfig(env);
  const level     = levelForAmount(amount, cfg.tiers);
  const donations = await getDonations(env);
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
  await env.DB.put('donations', JSON.stringify(donations));
  await updateLeaderboard(env, donations);
  return json({ ok: true });
}

// ── Queue ──────────────────────────────────────────────────────────────
async function handleQueue(env) {
  const donations = await getDonations(env);
  const pending   = donations.filter(d => d.status === 'pending');

  for (const d of donations) {
    if (d.status === 'pending') d.status = 'claimed';
  }
  if (pending.length) await env.DB.put('donations', JSON.stringify(donations));

  return json({
    data: pending.map(({ id, donor_name, amount, message, created_at }) => ({
      id, donor_name, amount, message, created_at,
    })),
  });
}

// ── Leaderboard ────────────────────────────────────────────────────────
async function handleLeaderboard(env) {
  const raw = await env.DB.get('leaderboard');
  return json({ data: raw ? JSON.parse(raw) : [] });
}

// ── History ────────────────────────────────────────────────────────────
async function handleHistory(env) {
  const donations = await getDonations(env);
  return json({ data: donations.slice(0, 20) });
}

// ── Delete ─────────────────────────────────────────────────────────────
async function handleDelete(id, env) {
  const donations = await getDonations(env);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return fail('Not found', 404);
  donations.splice(idx, 1);
  await env.DB.put('donations', JSON.stringify(donations));
  await updateLeaderboard(env, donations);
  return json({ ok: true });
}

// ── Edit Amount ────────────────────────────────────────────────────────
async function handleEditAmount(id, request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }
  const newAmount = Number(body.amount);
  if (!newAmount || newAmount <= 0) return fail('Amount tidak valid');

  const donations = await getDonations(env);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return fail('Not found', 404);

  donations[idx].amount = newAmount;
  await env.DB.put('donations', JSON.stringify(donations));
  await updateLeaderboard(env, donations);
  return json({ ok: true });
}

// ── Test Notif ─────────────────────────────────────────────────────────
async function handleTestNotif(env) {
  const donations = await getDonations(env);
  donations.unshift({
    id:         Date.now(),
    donor_name: 'TestDonor',
    amount:     25000,
    message:    'Test notification dari dashboard',
    status:     'pending',
    created_at: new Date().toISOString(),
  });
  if (donations.length > 100) donations.splice(100);
  await env.DB.put('donations', JSON.stringify(donations));
  await updateLeaderboard(env, donations);
  return json({ ok: true });
}

// ── Login ──────────────────────────────────────────────────────────────
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email, password } = body;

  // Cek akun utama (env vars) — admin
  if (email === env.ADMIN_EMAIL && password === env.ADMIN_PASS) {
    return json({ ok: true, key: env.API_KEY, isAdmin: true });
  }

  // Cek akun tambahan (KV) — bukan admin
  const accounts = await getAccounts(env);
  const found = accounts.find(a => a.email === email && a.password === password);
  if (found) {
    return json({ ok: true, key: env.API_KEY, isAdmin: false });
  }

  return json({ ok: false, error: 'Email atau password salah' }, 401);
}

// ── Accounts ───────────────────────────────────────────────────────────
async function getAccounts(env) {
  const raw = await env.DB.get('accounts');
  return raw ? JSON.parse(raw) : [];
}

async function handleListAccounts(env) {
  const accounts = await getAccounts(env);
  // Jangan kirim password ke frontend
  return json({ data: accounts.map(a => ({ email: a.email })) });
}

async function handleAddAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return fail('Email dan password wajib diisi');
  if (password.length < 4) return fail('Password minimal 4 karakter');

  const accounts = await getAccounts(env);
  if (accounts.find(a => a.email === email)) {
    return json({ ok: false, error: 'Email sudah terdaftar' }, 400);
  }

  accounts.push({ email, password });
  await env.DB.put('accounts', JSON.stringify(accounts));
  return json({ ok: true });
}

async function handleDeleteAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  const { email } = body;
  if (!email) return fail('Email wajib diisi');

  const accounts = await getAccounts(env);
  const filtered = accounts.filter(a => a.email !== email);
  await env.DB.put('accounts', JSON.stringify(filtered));
  return json({ ok: true });
}

// ── Helpers ────────────────────────────────────────────────────────────
async function getDonations(env) {
  const raw = await env.DB.get('donations');
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

async function handleGetConfig(env) {
  const raw = await env.DB.get('tier_config');
  return json(raw ? JSON.parse(raw) : DEFAULT_CONFIG);
}

async function handleSetConfig(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }
  await env.DB.put('tier_config', JSON.stringify(body));
  return json({ ok: true });
}

async function getConfig(env) {
  const raw = await env.DB.get('tier_config');
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
async function updateLeaderboard(env, donations) {
  const totals = {};
  for (const d of donations) {
    totals[d.donor_name] = (totals[d.donor_name] || 0) + (Number(d.amount) || 0);
  }
  const lb = Object.entries(totals)
    .map(([donor_name, total_amount]) => ({ donor_name, total_amount }))
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, 20);
  await env.DB.put('leaderboard', JSON.stringify(lb));
}

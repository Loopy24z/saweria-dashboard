# Multi-Tenant Accounts — Design

**Date:** 2026-06-29
**Status:** Approved (design)

## Tujuan

Satu Worker Cloudflare melayani banyak akun. Tiap akun punya **API key sendiri**
dan **data donasi sendiri** (donations, leaderboard, history, tier config) yang
terpisah total dari akun lain. Admin (loofyjo24) yang sekarang tetap jalan dan
datanya dipertahankan.

## Keputusan desain (hasil brainstorming)

1. **API key auto-generate** — dibuat otomatis (acak, unik) saat admin menambah akun.
2. **Admin = tenant spesial** — tetap login via `env.ADMIN_EMAIL` / `env.ADMIN_PASS`,
   tenant key = `env.API_KEY`, dan datanya tetap di KV key lama (backward compatible,
   tidak ada data hilang).
3. **Tier config per akun** — tiap akun punya config efek/nominal/warna sendiri;
   akun baru mulai dari `DEFAULT_CONFIG`.
4. **Namespacing: prefix per akun (Opsi 1)** — KV key jadi `donations:<key>`,
   `leaderboard:<key>`, `tier_config:<key>`. Admin pakai key lama tanpa prefix.

## Model data

### KV `accounts`

Sebelum: `[{ email, password }]`

Sesudah: `[{ email, password, apiKey }]`

- `apiKey` di-generate sekali saat akun dibuat, tidak pernah di-regenerate (YAGNI).
- `apiKey` unik antar akun dan tidak boleh sama dengan `env.API_KEY`.

### KV data per tenant

| Data        | Admin (key === env.API_KEY) | Akun biasa             |
|-------------|-----------------------------|------------------------|
| donations   | `donations`                 | `donations:<key>`      |
| leaderboard | `leaderboard`               | `leaderboard:<key>`    |
| tier config | `tier_config`               | `tier_config:<key>`    |

History memakai data `donations` yang sama (tidak ada KV terpisah).

## Komponen

### Helper resolusi tenant

- `nsKey(prefix, key)` — kembalikan `prefix` bila `key === env.API_KEY`,
  selain itu `` `${prefix}:${key}` ``.
- `resolveTenantKey(url, env)` — ambil `?key=`; valid bila `=== env.API_KEY`
  atau cocok dengan salah satu `account.apiKey`. Kembalikan key tervalidasi
  (atau null bila tidak dikenal).
- `generateApiKey()` — string acak (mis. `crypto.randomUUID()` atau hex acak),
  dijamin tidak bentrok dengan key yang sudah ada / `env.API_KEY`.

### Endpoint yang berubah

- **`POST /webhook/<key>`** (worker.js:38) — terima bila `key` cocok `env.API_KEY`
  ATAU salah satu `account.apiKey`. Simpan donasi ke namespace pemilik key.
  Key tidak dikenal → 401.
- **`GET /queue`, `/leaderboard`, `/history`** — baca dari namespace sesuai `?key=`.
- **`POST /history/{id}/delete`, `/history/{id}/edit`, `/test-notification`** —
  tulis ke namespace sesuai `?key=`.
- **`GET /config`, `POST /config`** — baca/tulis `tier_config` per namespace.
- **`POST /api/login`** (worker.js:239) — admin → kembalikan `env.API_KEY`,
  `isAdmin: true`. Akun biasa → kembalikan `account.apiKey` miliknya,
  `isAdmin: false`.
- **`GET /accounts`** (admin only) — kembalikan `[{ email, apiKey }]`
  (apiKey ikut, supaya admin bisa kasih ke tiap streamer). Password tetap tidak dikirim.
- **`POST /accounts`** (admin only) — generate `apiKey`, simpan
  `{ email, password, apiKey }`. Tolak email duplikat (perilaku sekarang dipertahankan).
- **`POST /accounts/delete`** (admin only) — hapus akun **dan** datanya
  (`donations:<key>`, `leaderboard:<key>`, `tier_config:<key>`).

### Dashboard (index.html)

- Login akun biasa otomatis menyimpan `apiKey` miliknya ke session, jadi panel
  "API Key" dan "Webhook URL" yang sudah ada langsung menampilkan milik akun itu
  tanpa perubahan logika.
- Daftar akun (admin) menampilkan `apiKey` tiap akun di samping email.

## Alur data

1. Admin tambah akun → worker generate `apiKey` → simpan ke `accounts`.
2. Admin kasih `apiKey` (+ webhook URL `/webhook/<apiKey>`) ke streamer.
3. Streamer set webhook itu di Saweria-nya, dan login dashboard pakai email/password
   → dapat `apiKey` sendiri.
4. Donasi masuk via `/webhook/<apiKey>` → tersimpan di `donations:<apiKey>`.
5. Roblox game streamer pull `/queue?key=<apiKey>` → hanya donasi miliknya.

## Error handling

- Webhook dengan key tidak dikenal → 401 (sama seperti sekarang).
- Endpoint lain dengan `?key=` tidak dikenal → 401 `Unauthorized`.
- Tambah akun: email/password wajib, password ≥ 4 char, email tidak duplikat
  (perilaku sekarang dipertahankan).

## Pengujian (manual, karena Cloudflare Worker + KV)

- Admin login → dapat `env.API_KEY`, lihat data lama (tidak hilang).
- Tambah akun baru → dapat apiKey unik; login akun itu → data kosong & terpisah.
- Webhook ke key akun baru → muncul hanya di queue/history akun itu, bukan admin.
- Config akun A diubah → tidak mempengaruhi akun B / admin.
- Hapus akun → akun + datanya hilang; akun lain tidak terpengaruh.

## Di luar scope (YAGNI)

- Regenerate API key.
- Self-signup (akun tetap dibuat admin).
- Migrasi/pindah data antar akun.
- Kuota / rate limit per akun.

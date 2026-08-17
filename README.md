# Backend Sehatica

API Hono + Bun + PostgreSQL untuk mobile/web Sehatica.

## Prasyarat

- [Bun](https://bun.sh)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (untuk PostgreSQL)
- Opsional: API key Groq untuk vision rekam medis & insight. Default lokal: `LLM_PROVIDER=dummy`.

## Apakah Docker harus nyala?

**Ya, Docker harus nyala** — tapi hanya untuk database Postgres.

| Komponen | Cara jalan | Port |
|---|---|---|
| PostgreSQL | `docker compose up -d` | `5432` |
| API backend | `bun run dev` (di host, bukan container) | `3000` |

## Setup cepat

### 1. Nyalakan Docker Desktop

### 2. Start database

```sh
cd backend-sehatica
docker compose up -d
```

### 3. Environment

```sh
cp .env.example .env
```

Isi minimal:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/sehatica
JWT_SECRET=ganti-dengan-secret-panjang
PORT=3000
```

Untuk AI vision rekam medis (foto/PDF):

```env
LLM_PROVIDER=groq
LLM_API_KEY=gsk_...
LLM_MODEL=qwen/qwen3.6-27b
```

Key: https://console.groq.com/keys

### 4. Install & push schema

```sh
bun install
bun run db:push
```

Setelah migrasi dari versi lama (Heally), jalankan SQL perbaikan jika `db:push` gagal di tengah (error constraint `heally_asks_message_id_...`):

```sh
docker compose exec -T postgres psql -U postgres -d sehatica < scripts/fix-rdsa-migration.sql
bun run db:push
```

Atau manual di Postgres:

```sql
ALTER TABLE heally_asks RENAME TO rdsa_asks;  -- skip jika sudah rdsa_asks
DROP TABLE IF EXISTS verif_requests CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
ALTER TABLE rdsa_asks DROP COLUMN IF EXISTS message_id;
```

Saat prompt Drizzle **"Is rdsa_asks created or renamed?"** → pilih **`heally_asks › rdsa_asks rename table`**.

### 5. Jalankan API

```sh
bun run dev
```

Cek: http://localhost:3000/health

## Scripts

| Command | Keterangan |
|---|---|
| `bun run dev` | API hot-reload di port 3000 |
| `bun run db:push` | Sync schema Drizzle ke Postgres |
| `bun run db:generate` | Generate migration SQL |
| `bun run db:studio` | Drizzle Studio |
| `bun run db:seed-arms` | Seed 275 notification arms (RDSA) |
| `bun run db:migrate-portal` | Migrasi tabel doctor portal (non-interaktif) |
| `bun run db:seed-portal` | Seed ringan portal (tanpa kuisioner) |
| `bun run db:seed-demo` | Seed lengkap `demo@sehatica.test` + dokter partner |

## Doctor portal (web-sehatica)

Setelah `db:push`, jalankan migrasi portal dan seed demo:

```sh
bun run db:migrate-portal
bun run db:seed-demo
```

Login pasien mobile:
- `demo@sehatica.test` / `password123`
- `demo@test.com` (Muhammad Rizain Firdaus) / `password123`  
Login web dokter: `dokter@sehatica.test` / `password123`

### API portal (auth dokter)

| Method | Path | Keterangan |
|---|---|---|
| GET/PATCH | `/api/v1/portal/me` | Profil dokter |
| GET | `/api/v1/portal/patients` | Daftar pasien partner |
| GET | `/api/v1/portal/patients/:id` | Monitor detail pasien |
| GET | `/api/v1/portal/patients/:id/questionnaires/:date` | Log kuisioner harian |
| GET | `/api/v1/portal/patients/:id/questionnaires/latest-summary` | Ringkasan AI terbaru |
| GET/POST/DELETE | `/api/v1/portal/appointments` | Janji dokter ↔ pasien |

### Sync mobile → backend

| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/v1/health/weekly-sync` | Cek mingguan |
| POST | `/api/v1/health/questionnaire-sync` | Kuisioner harian lengkap |
| GET | `/api/v1/appointments` | Janji pasien (dari dokter) |

Struktur kode portal: `src/routes/portal.ts`, `src/services/portal/*`

### Ringkasan AI kuisioner (Groq)

Ringkasan **tidak** mengirim 52 field mentah ke LLM. Backend melakukan preprocessing ke compact JSON (~300 token), lalu memanggil Groq.

Wajib di `.env`:

```env
LLM_PROVIDER=groq
LLM_API_KEY=gsk_...
LLM_MODEL=openai/gpt-oss-120b
```

| Mode | Kapan | Input ke LLM |
|---|---|---|
| **Health Summary** | Kuisioner pertama / tanpa riwayat sebelumnya | demographic + lifestyle + anthropometric + risk band |
| **Daily delta** | Ada kuisioner hari sebelumnya | perbandingan activity, sedentary, calories, sugar, sodium |

Tanpa `LLM_MODEL` + key, backend memakai fallback teks singkat (dev mode).

Dipanggil otomatis saat `POST /health/questionnaire-sync` dan saat daily-sync menyertakan `questionnaire`.

## LLM & RDSA

Default lokal: `LLM_PROVIDER=dummy` (tanpa `LLM_API_KEY`).

| Fitur | Cara kerja |
|---|---|
| Rekam medis **PDF** | Ekstrak teks PDF → Groq LLM → JSON standar |
| Rekam medis **foto** | Groq Vision → JSON standar |
| **RDSA** smart notifications | SoftMax bandit, push-only (tanpa chat) |

RDSA endpoints (auth required):

- `POST /api/v1/rdsa/asks/trigger` — eligibility + SoftMax → deliver push notification
- `GET /api/v1/rdsa/asks/pending` — asks menunggu ack (mobile poll)
- `POST /api/v1/rdsa/asks/:askId/ack`
- `POST /api/v1/rdsa/arms/seed` — upsert templates

Setelah `db:push`, jalankan `bun run db:seed-arms` sekali.

## Hubungkan ke mobile

```
http://localhost:3000/api/v1
```

| Platform | Base URL |
|---|---|
| Web / iOS Simulator | `http://localhost:3000/api/v1` |
| Android Emulator | `http://10.0.2.2:3000/api/v1` |
| HP fisik | `http://<IP-LAN>:3000/api/v1` |

## Akun demo (development)

```sh
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo User","email":"demo@sehatica.test","password":"password123"}'
```

## Troubleshooting

### Postgres / schema

```sh
docker compose up -d
bun run db:push
```

### AI vision rekam medis gagal

Set `LLM_PROVIDER=groq` + `LLM_API_KEY`, restart `bun run dev`.

Notifikasi kosong? Jalankan `bun run db:seed-arms`.

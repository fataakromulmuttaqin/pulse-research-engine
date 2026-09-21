# PRD: Pulse — Mesin Riset Pasar untuk Kreator, Marketer & UMKM

Status: Draft v1.0 · 22 Sep 2026 · Turunan dari `BLUEPRINT.md` + review arsitektur (jev-search, treg)

---

## 1. Latar Belakang & Masalah

Kreator, marketer, dan UMKM membayar 3–4 alat terpisah (exploding topics, social listening,
Semrush, brand monitor) untuk kebutuhan yang sebenarnya satu: *tahu apa yang terjadi di
pasarnya dan tindakan apa yang harus diambil* — dengan harga masing-masing $39–139/bulan.

**Solusi:** satu website dengan 4 modul riset yang berbagi satu mesin riset multi-sumber,
dengan model biaya data per-call (bukan langganan menganggur), sehingga bisa dijual mulai
Rp 49rb/bulan.

## 2. Tujuan Produk (Goals)

- G1: Kreator/marketer bisa tahu topik yang sedang naik di niche mereka dalam <5 menit/hari,
  tanpa berlangganan 3–4 tools terpisah.
- G2: COGS per user aktif tetap di kisaran Rp 300–1.500/bulan pada skala 100 user (§7 blueprint),
  supaya margin ~70–80% tercapai tanpa subsidi.
- G3: Sistem tetap berjalan dan mengirim digest walau salah satu sumber data down/limit habis
  (tidak ada single point of failure di lapisan data).

### Non-Goals (di luar cakupan MVP)

- Brand Monitor real-time (Modul B), Lead Finder (Modul C), SEO Gap (Modul D) — lihat §6 Sequencing.
- Ekspansi bahasa Inggris/pasar global.
- Public API (`/api/v1/*`) — ditunda sampai ada permintaan dari user Agency nyata.

## 3. Target Pengguna

| Persona | Kebutuhan | Modul relevan |
|---|---|---|
| Kreator konten (mis. gadget reviewer) | Ide topik/hook harian tanpa riset manual | A |
| Marketer/agency kecil | Pantau sebutan brand klien | B |
| Founder/sales kecil | Temukan lead dari sinyal pasar | C |
| UMKM/blogger lokal | Tahu keyword yang bisa dimenangkan dari kompetitor | D |

MVP hanya menyasar persona pertama (kreator/marketer individual), sesuai rekomendasi
sequencing di §6 — bukan agency/UMKM yang butuh Modul B/C/D dulu.

## 4. Lingkup MVP (Modul A — Trend Brief)

### 4.1 Alur pengguna utama

1. User daftar (magic link email, reuse pola auth Clapclip).
2. User isi niche (teks bebas, mis. "gadget review") + jendela waktu (7/30 hari).
3. Sistem mengirim digest: 5 topik naik + 1 "peluang konten" pilihan + draft hook per topik,
   via email atau Telegram, sesuai jadwal (harian untuk Starter+, 3x/minggu untuk Free).
4. User bisa klik "Clapclip-kan" pada satu topik → topik terkirim sebagai draft pipeline
   video shorts ke produk Clapclip (lihat integrasi ekosistem, §4.4).

### 4.2 Functional Requirements

| ID | Requirement | Prioritas |
|---|---|---|
| FR-1 | User dapat mendaftar/login via magic link email | Must |
| FR-2 | User dapat menambah 1 niche (Free/Starter) hingga 5 niche (Pro) | Must |
| FR-3 | Sistem menjalankan riset harian per niche aktif dan menghasilkan brief terstruktur (5 topik + skor) | Must |
| FR-4 | Brief dikirim via email (Resend) dan/atau Telegram bot | Must |
| FR-5 | User dapat melihat arsip brief di `/dashboard/briefs` | Must |
| FR-6 | Brief menampilkan status transparan bila salah satu sumber data degraded/gagal pada hari itu | Must |
| FR-7 | Tombol "Clapclip-kan" mengirim topik terpilih ke antrian Clapclip | Should |
| FR-8 | User dapat mengatur kanal kirim dan jendela waktu di `/dashboard/settings` | Should |
| FR-9 | Watermark ringan pada digest Free tier | Could |

### 4.3 Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | Satu sumber data gagal/timeout tidak boleh menggagalkan seluruh brief harian (lihat §7 Arsitektur) |
| NFR-2 | Biaya data per user aktif tetap dalam anggaran plan-nya (quota lokal, bukan hanya mengandalkan saldo treg) |
| NFR-3 | Job digest harian punya budget waktu eksplisit (deadline per-lane + overall) agar tidak menggantung di scheduler |
| NFR-4 | Hasil scoring LLM tervalidasi skema; kegagalan parsing tidak menggagalkan batch, hanya menandai item "unscored" |
| NFR-5 | Query yang identik dalam jendela cache tidak memicu pemanggilan ulang sumber berbayar |

### 4.4 Integrasi ekosistem Clapclip

- "Clapclip-kan" mengirim `{topik, hook_draft, sumber}` ke endpoint internal Clapclip
  (bukan API publik) — kontrak data ini perlu disepakati terpisah dengan tim Clapclip
  sebelum FR-7 dikerjakan.
- Pembeli Pro/Agency Pulse mendapat diskon kuota Clapclip (linked di layer billing,
  bukan di mesin riset).

## 5. Arsitektur (ringkasan — detail teknis di skeleton kode terlampir)

```
[Niche dari user]
      │
      ▼
 data-provider layer (src/types.ts: FetchLane interface)
      │
      ├─ Lane gratis: News, YouTube (Search1API)         — MVP
      ├─ Lane berbayar: treg (trend/social per-call)     — ditambah setelah lane gratis stabil
      │
      ▼
 cache per-lane (Upstash Redis, TTL 10 menit–6 jam)
      ▼
 merge + dedupe by URL
      ▼
 scoring terstruktur (LLM + Zod schema, retry 1x, fallback 'unscored')
      ▼
 digest harian → email/Telegram
```

Prinsip wajib (lihat README skeleton untuk detail):
- Satu lane gagal → status `degraded`/`failed` pada lane itu saja, brief tetap terkirim.
- Kuota biaya dicek **lokal** per user/plan sebelum memanggil lane berbayar — treg 402
  harus jadi kejadian langka (saldo tim habis), bukan mekanisme kontrol utama.
- Job digest dipicu lewat queue (QStash/Inngest), bukan langsung dieksekusi di handler
  Vercel Cron, agar tidak kena batas eksekusi saat user bertambah.

### Stack

| Layer | Pilihan | Catatan |
|---|---|---|
| Frontend + API | Vercel | reuse pola Clapclip |
| DB relasional | Neon Postgres | user, niche, brief, ledger |
| Cache lane | Upstash Redis | terpisah dari Neon — lihat alasan di `cache.ts` |
| Queue job | QStash/Inngest | cron hanya trigger, tidak eksekusi langsung |
| Data lane gratis | Search1API | News, YouTube (MVP) |
| Data lane berbayar | treg | ditambah pasca-MVP, per modul yang butuh |
| LLM scoring | Gemini (structured output) | fallback 'unscored', bukan crash |
| Notifikasi | Resend (email) + Telegram bot | |

## 6. Sequencing / Roadmap (revisi dari blueprint §6)

| Fase | Deliverable | Go/No-Go |
|---|---|---|
| 0. Validasi | Brief manual 1 niche ke 5–10 orang via Telegram | Ukur open-rate & respons |
| **0.5. Fondasi engine (baru)** | `ResearchEngine` + 1 lane (News+YouTube) lengkap dengan cache, dedupe, scoring terstruktur, test mock provider | Pipeline lulus test tanpa API asli |
| 1. Tambah lane treg | Lane berbayar terintegrasi di atas fondasi yang sudah stabil | Biaya sesuai estimasi §7 blueprint |
| 2. MVP Modul A | Dashboard, auth, billing sederhana (Midtrans), dibangun di atas engine yang teruji | ≥10 user bayar Starter dalam 30 hari |
| 3. Ledger & quota | `UsageLedgerStore` Postgres + quota enforcement per plan | Wajib **sebelum** Modul B/C dimulai |
| 4. Modul B (Brand Monitor) | Alert + sentimen | Sesuai definisi §3 blueprint (bukan tertukar dgn Modul C) |
| 5. Modul C (Lead Finder) | Enrichment + webhook | COGS tertinggi — hanya Pro/Agency |
| 6. Modul D + API publik | SEO gap, `/api/v1/*` | |

Catatan: penomoran Modul B/C di roadmap asli (§6 blueprint) tertukar dengan definisi di §3 —
tabel di atas sudah dikoreksi mengikuti definisi §3 (B = Brand Monitor, C = Lead Finder).

## 7. Model Bisnis

Pricing mengikuti §5 blueprint tanpa perubahan (Free/Starter Rp49k/Pro Rp149k/Agency Rp399k).
Perubahan yang direkomendasikan: **quota biaya data per plan ditegakkan di kode** (lihat
`ledger.ts` pada skeleton), bukan hanya asumsi di proyeksi §7 blueprint — supaya satu user
niche "berat" tidak menghabiskan saldo treg bersama dan mengganggu user lain.

## 8. Metrik Sukses

- Milestone go/no-go MVP: ≥10 user bayar Starter dalam 30 hari pasca-launch (tidak berubah
  dari blueprint).
- Metrik operasional tambahan yang perlu dipantau sejak MVP:
  - % brief harian yang terkirim dengan minimal 1 lane degraded/failed (target awal <20%,
    dipakai untuk memutuskan kapan menambah lane cadangan).
  - Rata-rata biaya data per user aktif vs anggaran plan (dari ledger) — sinyal dini kalau
    proyeksi §7 blueprint meleset.

## 9. Risiko (tambahan di luar §8 blueprint)

| Risiko | Mitigasi |
|---|---|
| Lisensi treg: additional terms Apache-2.0 melarang menawarkan treg sebagai layanan hosted ke pihak ketiga atau membundelnya ke produk komersial tanpa izin | Pulse hanya jadi **klien** treg (hosted, treg.superdesign.dev) untuk MVP; konfirmasi tertulis ke pemilik repo dulu bila mempertimbangkan self-host untuk kendali biaya |
| Skor LLM tidak valid/parse gagal menggagalkan seluruh brief | Structured output + Zod validation + fallback 'unscored' (lihat `scoring.ts`) |
| Satu user menghabiskan saldo treg bersama | Quota lokal per user/plan sebelum memanggil lane berbayar (lihat `ledger.ts`) |
| Cron job timeout saat user bertambah | Job dipicu queue, bukan langsung di handler cron |

## 10. Keputusan Terbuka (dari §9 blueprint, belum berubah)

1. Nama & domain final.
2. Niche peluncuran (rekomendasi: creator economy/gadget, cross-sell dengan Clapclip).
3. Payment gateway: Midtrans vs Stripe/Paddle.
4. Konfirmasi tertulis dari pemilik treg bila self-hosting dipertimbangkan (baru, lihat §9 di atas).

## Lampiran

Skeleton kode `ResearchEngine` (TypeScript) yang mengimplementasikan §5–§6 di atas
disertakan terpisah (`pulse-research-engine.zip`) — lihat README di dalamnya untuk
detail struktur dan hal yang wajib diisi sebelum production.

**Verifikasi skeleton (22 Sep 2026):** `vitest run` 2/2 lulus; `tsc --noEmit` bersih
setelah menambahkan `@types/node` ke devDependencies (kuditulis ke package.json —
sebelumnya tidak ada, typecheck gagal di semua file yang memakai `process`/`crypto`).

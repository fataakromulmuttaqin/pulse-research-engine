# Pulse — Research Engine (skeleton)

Skeleton lapisan abstraksi `data-provider` yang direkomendasikan sebelum Modul A dibangun.
Semua modul (A/B/C/D) nantinya hanya bergantung pada `src/types.ts` dan `src/pipeline.ts` —
tidak pernah memanggil Search1API/Treg langsung. Ini yang membuat lane bisa ditukar atau
ditambah tanpa menyentuh kode modul (lihat §8 blueprint: "Dependency ke Jev/Treg").

## Struktur

| File | Peran |
|---|---|
| `src/types.ts` | Kontrak inti: `FetchLane`, `RawItem`, `ScoredItem`, `LaneResult` |
| `src/cache.ts` | Cache respons per lane (Upstash Redis), TTL beda per jendela waktu |
| `src/ledger.ts` | Quota LOKAL per user/plan — dicek sebelum lane berbayar dipanggil |
| `src/lanes/search1api.ts` | Lane gratis: News, YouTube (Reddit/X tinggal tambah service baru) |
| `src/lanes/treg.ts` | Lane berbayar via treg, dengan penanganan eksplisit HTTP 402 |
| `src/merge.ts` | Dedupe by URL lintas lane |
| `src/scoring.ts` | Skor LLM terstruktur (Zod-validated), gagal parse tidak menggagalkan batch |
| `src/pipeline.ts` | Orkestrasi: streaming per-lane, isolasi kegagalan, overall deadline |
| `src/index.ts` | Contoh pemakaian dari job digest harian |
| `src/pipeline.test.ts` | Test dengan lane palsu — tidak memanggil API asli |

## Prinsip yang ditiru dari jev-search & treg

- **Isolasi kegagalan per lane**: satu lane gagal/timeout tidak menjatuhkan seluruh brief.
- **Deadline berlapis**: `lane.timeoutMs` di dalam `overallTimeoutMs` (default 30 detik).
- **Cache hanya untuk hasil sukses & tidak kosong** — mencegah brief kosong ter-cache 6 jam.
- **402 treg ditangani sebagai kondisi terkelola** (`TregBalanceError`), bukan crash generik.
- **Structured output + validasi** untuk skor LLM, bukan parsing freeform.
- **Test dengan mock provider** — CI tidak menghabiskan kredit Search1API/treg/Gemini asli.

## Yang HARUS diisi sebelum dipakai production

1. `TREND_TOOL_ID` di `lanes/treg.ts` — ganti dengan tool id nyata hasil `treg catalog search`.
2. Mapping field respons Search1API di `lanes/search1api.ts` (`toRawItem`) — sesuaikan
   dengan payload asli, contoh saat ini ilustratif.
3. `PLAN_QUOTAS` di `ledger.ts` — angka masih placeholder, kalibrasi dari data Fase 0.
4. `SCORE_WEIGHTS` di `scoring.ts` — kalibrasi dengan ground truth ("topik ini benar-benar
   naik 3–7 hari kemudian?", §8 blueprint).
5. `UsageLedgerStore` — ganti `InMemoryLedgerStore` dengan implementasi Neon/Postgres.
6. Environment variables: `SEARCH1API_API_KEY`, `TREG_BASE_URL`, `TREG_TOKEN`,
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GEMINI_API_KEY`.

## Yang sengaja TIDAK ada di skeleton ini

- Job scheduler (QStash/Inngest) — pipeline ini dipanggil dari job, bukan dari handler
  cron langsung, supaya tidak kena batas eksekusi Vercel Cron saat user bertambah.
- UI/dashboard — skeleton ini murni lapisan mesin riset.
- Implementasi Postgres nyata untuk `UsageLedgerStore` — interface sudah ada, tinggal isi.

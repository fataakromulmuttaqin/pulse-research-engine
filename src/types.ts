// src/types.ts
// Kontrak inti — semua modul (A/B/C/D) hanya bergantung pada file ini,
// tidak pernah langsung memanggil Search1API/Treg. Ini yang membuat lane
// bisa ditukar tanpa menyentuh kode modul (lihat §8 blueprint: "Dependency ke Jev/Treg").

export type LaneName = 'youtube' | 'reddit' | 'news' | 'x' | 'treg';

export interface TimeWindow {
  /** 7 atau 30 hari — dipakai juga untuk menentukan TTL cache, lihat cache.ts */
  days: 7 | 30;
}

/** Satu hasil mentah dari satu lane, sebelum dedupe/scoring. */
export interface RawItem {
  id: string; // hash(url), dipakai sebagai kunci dedupe
  url: string;
  title: string;
  snippet: string;
  source: LaneName;
  publishedAt?: string; // ISO 8601 kalau lane tahu tanggalnya
  raw?: unknown; // payload asli, untuk debugging — jangan dipakai modul
}

/** Hasil satu lane setelah dijalankan — status 'degraded'/'failed' TIDAK melempar error. */
export interface LaneResult {
  lane: LaneName;
  status: 'ok' | 'degraded' | 'failed';
  items: RawItem[];
  error?: string;
  costMicro: number; // biaya lane ini dalam micro-dollar (0 untuk lane gratis), untuk ledger.ts
  cached: boolean;
  tookMs: number;
}

/** Item setelah discore oleh scoring.ts */
export interface ScoredItem extends RawItem {
  relevance: number; // 0..1
  momentum: number; // 0..1
  freshness: number; // 0..1
  score: number; // weighted final, lihat scoring.ts SCORE_WEIGHTS
  scoreStatus: 'ok' | 'unscored'; // 'unscored' = LLM gagal 2x, jangan pernah crash pipeline
}

/**
 * Kontrak yang wajib dipenuhi setiap sumber data (YouTube, Reddit, News, X, Treg, ...).
 * Menambah sumber baru = implement interface ini, tidak menyentuh pipeline.ts.
 */
export interface FetchLane {
  name: LaneName;
  /** Deadline lane ini sendiri. Pola jev-search: per-engine timeout di dalam overall timeout. */
  timeoutMs: number;
  /** Kalau false, lane ini kena biaya (mis. treg) — dipakai ledger.ts untuk cek kuota SEBELUM fetch. */
  isFree: boolean;
  /** Perkiraan biaya dalam micro-dollar untuk satu panggilan (0 kalau isFree). */
  estimatedCostMicro: number;
  fetch(query: string, window: TimeWindow): Promise<RawItem[]>;
}

export interface EngineRunOptions {
  userId: string; // dipakai ledger.ts untuk quota check per user, bukan per tim
  niche: string; // teks bebas dari user, mis. "gadget review"
  window: TimeWindow;
  lanes: FetchLane[];
  overallTimeoutMs?: number; // default 30_000, meniru jev-search
}

export class QuotaExceededError extends Error {
  constructor(public userId: string, public planId: string) {
    super(`Kuota bulanan plan ${planId} untuk user ${userId} sudah habis`);
    this.name = 'QuotaExceededError';
  }
}

/** Dilempar khusus oleh lane treg saat saldo tim habis (HTTP 402 dari treg). */
export class TregBalanceError extends Error {
  constructor(public balanceMicro: number, public estimatedCostMicro: number, public topupUrl: string) {
    super(`Saldo treg tidak cukup: perlu ${estimatedCostMicro}, sisa ${balanceMicro}`);
    this.name = 'TregBalanceError';
  }
}

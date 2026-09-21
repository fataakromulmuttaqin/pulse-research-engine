// src/pipeline.ts
//
// Ini "mesin riset" yang dimaksud §2 blueprint. Prinsip yang ditiru dari
// jev-search/pipeline.ts:
//   - Setiap lane punya deadline sendiri (lane.timeoutMs), dibungkus overall
//     deadline (opts.overallTimeoutMs, default 30 detik).
//   - SATU LANE GAGAL TIDAK MENGGAGALKAN LANE LAIN. Hasil tetap jalan dengan
//     status 'degraded'/'failed' pada lane itu saja.
//   - Hasil di-stream sebagai async generator per lane selesai — pemanggil
//     (mis. job digest harian) bisa mulai proses lane pertama tanpa menunggu
//     lane treg yang paling lambat/mahal.
//   - Lane berbayar (isFree: false) dicek kuota LOKAL dulu (ledger.ts)
//     SEBELUM fetch dipanggil — supaya 402 dari treg jadi kejadian langka,
//     bukan mekanisme kontrol utama.

import { getCached, setCached } from './cache';
import { assertWithinQuota, type PlanQuota, type UsageLedgerStore } from './ledger';
import { mergeLaneResults } from './merge';
import { scoreItems } from './scoring';
import type { EngineRunOptions, FetchLane, LaneResult, ScoredItem } from './types';
import { QuotaExceededError, TregBalanceError } from './types';

async function runSingleLane(
  lane: FetchLane,
  query: string,
  window: EngineRunOptions['window'],
  ledger: { store: UsageLedgerStore; quota: PlanQuota; userId: string },
): Promise<LaneResult> {
  const started = Date.now();

  // 1. Cache check dulu — hindari billing ulang untuk query yang sama dalam TTL.
  const cached = await getCached(lane.name, query, window);
  if (cached) {
    return { lane: lane.name, status: 'ok', items: cached, costMicro: 0, cached: true, tookMs: Date.now() - started };
  }

  // 2. Kuota LOKAL untuk lane berbayar — dicek sebelum fetch, bukan sesudah.
  if (!lane.isFree) {
    try {
      await assertWithinQuota(ledger.store, ledger.userId, ledger.quota, lane.estimatedCostMicro);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return { lane: lane.name, status: 'failed', items: [], error: err.message, costMicro: 0, cached: false, tookMs: Date.now() - started };
      }
      throw err;
    }
  }

  // 3. Fetch dengan deadline lane sendiri, race melawan timeout eksplisit
  //    (di atas timeout internal `fetch`'s AbortController milik masing-masing lane).
  try {
    const items = await Promise.race([
      lane.fetch(query, window),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lane timeout')), lane.timeoutMs)),
    ]);

    await setCached(lane.name, query, window, items);
    if (!lane.isFree) {
      await ledger.store.recordUsage(ledger.userId, lane.name, lane.estimatedCostMicro);
    }
    return { lane: lane.name, status: 'ok', items, costMicro: lane.isFree ? 0 : lane.estimatedCostMicro, cached: false, tookMs: Date.now() - started };
  } catch (err) {
    if (err instanceof TregBalanceError) {
      // Saldo tim habis: lane ini degraded, TAPI brief tetap jalan dengan lane lain.
      // TODO: trigger notifikasi admin (mis. webhook) untuk top-up, lihat err.topupUrl.
      return {
        lane: lane.name,
        status: 'degraded',
        items: [],
        error: `saldo treg habis: ${err.message}`,
        costMicro: 0,
        cached: false,
        tookMs: Date.now() - started,
      };
    }
    return {
      lane: lane.name,
      status: 'failed',
      items: [],
      error: err instanceof Error ? err.message : String(err),
      costMicro: 0,
      cached: false,
      tookMs: Date.now() - started,
    };
  }
}

/**
 * Jalankan semua lane secara paralel dan yield LaneResult SEGERA setiap lane
 * selesai (bukan menunggu Promise.all) — supaya konsumen (mis. UI progresif
 * atau job digest) bisa mulai menampilkan/memroses hasil lebih awal.
 */
export async function* runLanesStreaming(
  opts: EngineRunOptions,
  ledger: { store: UsageLedgerStore; quota: PlanQuota },
): AsyncGenerator<LaneResult> {
  const overallDeadline = Date.now() + (opts.overallTimeoutMs ?? 30_000);

  const pending = new Map(
    opts.lanes.map((lane, idx) => [
      idx,
      runSingleLane(lane, opts.niche, opts.window, { ...ledger, userId: opts.userId }).then((result) => ({ idx, result })),
    ]),
  );

  while (pending.size > 0) {
    const remainingMs = overallDeadline - Date.now();
    if (remainingMs <= 0) {
      // Overall deadline lewat — lane yang belum selesai dianggap 'failed',
      // tapi lane yang SUDAH selesai tetap sudah di-yield sebelumnya.
      for (const idx of pending.keys()) {
        const lane = opts.lanes[idx];
        yield { lane: lane.name, status: 'failed', items: [], error: 'overall deadline exceeded', costMicro: 0, cached: false, tookMs: remainingMs };
      }
      return;
    }

    const timeoutMarker = Symbol('timeout');
    const winner = await Promise.race([
      ...pending.values(),
      new Promise<typeof timeoutMarker>((resolve) => setTimeout(() => resolve(timeoutMarker), remainingMs)),
    ]);

    if (winner === timeoutMarker) continue; // loop lagi, deadline check di atas akan menangkapnya

    const { idx, result } = winner as { idx: number; result: LaneResult };
    pending.delete(idx);
    yield result;
  }
}

export interface ResearchBrief {
  niche: string;
  window: EngineRunOptions['window'];
  laneResults: LaneResult[]; // untuk transparansi/QA: lane mana yang degraded
  items: ScoredItem[];
}

/**
 * Entry point utama Modul A. Mengumpulkan seluruh lane, dedupe, lalu skor.
 * Kalau butuh streaming progresif (mis. ke UI), pakai runLanesStreaming
 * langsung; fungsi ini untuk kasus batch (job cron generate digest harian).
 */
export async function runResearch(
  opts: EngineRunOptions,
  ledger: { store: UsageLedgerStore; quota: PlanQuota },
): Promise<ResearchBrief> {
  const laneResults: LaneResult[] = [];
  for await (const result of runLanesStreaming(opts, ledger)) {
    laneResults.push(result);
  }

  const merged = mergeLaneResults(laneResults);
  const scored = await scoreItems(merged, opts.niche);
  scored.sort((a, b) => b.score - a.score);

  return { niche: opts.niche, window: opts.window, laneResults, items: scored };
}

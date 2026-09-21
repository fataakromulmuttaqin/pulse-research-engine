// src/index.ts
// Contoh pemakaian dari job digest harian (dipicu queue/QStash, BUKAN langsung
// dari handler Vercel Cron — lihat catatan di README.md soal cron timeout).

import { newsLane, youtubeLane } from './lanes/search1api';
import { createTregTrendLane } from './lanes/treg';
import { InMemoryLedgerStore, PLAN_QUOTAS } from './ledger';
import { runResearch } from './pipeline';
import type { EngineRunOptions } from './types';

export async function generateDailyBrief(userId: string, niche: string, plan: keyof typeof PLAN_QUOTAS) {
  // Ganti InMemoryLedgerStore dengan implementasi Postgres/Neon di production.
  const ledgerStore = new InMemoryLedgerStore();

  const lanes: EngineRunOptions['lanes'] = [newsLane, youtubeLane];
  // Lane treg hanya untuk plan Pro/Agency ke atas — cek plan sebelum menambah lane berbayar.
  if (plan === 'pro' || plan === 'agency') {
    lanes.push(createTregTrendLane(niche));
  }

  const brief = await runResearch(
    { userId, niche, window: { days: 7 }, lanes },
    { store: ledgerStore, quota: PLAN_QUOTAS[plan] },
  );

  // QA/observability: log lane mana yang degraded/failed, jangan diam-diam ditelan.
  const problematic = brief.laneResults.filter((r) => r.status !== 'ok');
  if (problematic.length > 0) {
    console.warn('Lane bermasalah pada brief ini:', problematic);
  }

  const top5 = brief.items.filter((i) => i.scoreStatus === 'ok').slice(0, 5);
  return { ...brief, top5 };
}

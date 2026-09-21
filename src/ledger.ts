// src/ledger.ts
//
// Kenapa perlu ini padahal treg sudah punya balance & 402 sendiri?
// treg menagih ke SALDO TIM (satu balance untuk semua user Pulse), bukan per
// end-user. Tanpa lapisan ini, satu user niche "berat" bisa menghabiskan
// saldo bersama dan mengganggu user lain. Jadi kita cek kuota LOKAL dulu,
// sebelum treg sempat menagih apa pun — 402 dari treg seharusnya jadi kejadian
// langka (saldo tim habis), bukan mekanisme kontrol kuota per-user utama.

import type { LaneName } from './types';
import { QuotaExceededError } from './types';

export interface PlanQuota {
  planId: 'free' | 'starter' | 'pro' | 'agency';
  monthlyBudgetMicro: number; // batas keras Rupiah-equivalent per bulan, ditentukan dari §5 pricing
}

// Nilai contoh — HARUS dikalibrasi ulang dari data real Fase 0 (§7 unit economics),
// jangan dipakai sebagai angka final tanpa validasi.
export const PLAN_QUOTAS: Record<PlanQuota['planId'], PlanQuota> = {
  free: { planId: 'free', monthlyBudgetMicro: 0 }, // free = tidak boleh sentuh lane berbayar sama sekali
  starter: { planId: 'starter', monthlyBudgetMicro: 5_000_000 }, // ~Rp 5rb ekuivalen biaya data
  pro: { planId: 'pro', monthlyBudgetMicro: 20_000_000 },
  agency: { planId: 'agency', monthlyBudgetMicro: 80_000_000 },
};

/**
 * Implementasi konkret (mis. lewat Neon/Prisma) tinggal memenuhi interface ini.
 * Dipisah sebagai interface supaya pipeline.ts bisa dites dengan store palsu (in-memory),
 * tanpa perlu koneksi database asli — pola yang sama dengan "provider-independent tests" jev-search.
 */
export interface UsageLedgerStore {
  getMonthlySpendMicro(userId: string): Promise<number>;
  recordUsage(userId: string, lane: LaneName, costMicro: number, meta?: Record<string, unknown>): Promise<void>;
}

/** Store in-memory — dipakai untuk test unit, JANGAN dipakai di production. */
export class InMemoryLedgerStore implements UsageLedgerStore {
  private spend = new Map<string, number>();

  async getMonthlySpendMicro(userId: string): Promise<number> {
    return this.spend.get(userId) ?? 0;
  }

  async recordUsage(userId: string, _lane: LaneName, costMicro: number): Promise<void> {
    this.spend.set(userId, (this.spend.get(userId) ?? 0) + costMicro);
  }
}

/** Panggil ini SEBELUM menjalankan lane berbayar. Melempar QuotaExceededError kalau lewat batas. */
export async function assertWithinQuota(
  store: UsageLedgerStore,
  userId: string,
  quota: PlanQuota,
  estimatedCostMicro: number,
): Promise<void> {
  const spent = await store.getMonthlySpendMicro(userId);
  if (spent + estimatedCostMicro > quota.monthlyBudgetMicro) {
    throw new QuotaExceededError(userId, quota.planId);
  }
}

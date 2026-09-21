// src/lanes/treg.ts
//
// treg (treg.superdesign.dev) adalah proxy kredensial untuk ~2.600 endpoint
// (SEO/backlink, social/trends, enrichment, dsb), ditagih per-call ke saldo
// prepaid TIM. Dua hal wajib ditangani secara eksplisit di sini:
//
// 1. HTTP 402 (saldo tim habis) — treg mengembalikan balance_micro,
//    estimated_cost_micro, topup_url secara terstruktur. JANGAN diperlakukan
//    sebagai error generik: lempar TregBalanceError supaya pipeline bisa
//    menandai lane ini 'degraded' (bukan mematikan seluruh brief) dan
//    memicu notifikasi admin untuk top-up.
// 2. Endpoint tanpa harga dipublikasikan → treg menolak (bukan gratis diam-diam).
//    Jangan asumsikan semua endpoint di catalog treg otomatis bisa dipanggil.
//
// PENTING (lisensi): kode ini memanggil treg SEBAGAI KLIEN HTTP ke instance
// hosted (treg.superdesign.dev) atau instance self-hosted milik tim sendiri.
// Apache-2.0 + additional terms treg melarang menawarkan treg itu sendiri
// sebagai layanan hosted ke pihak ketiga atau membundelnya ke produk
// komersial tanpa izin tertulis — konfirmasi ini SEBELUM memutuskan self-host.

import { createHash } from 'crypto';
import type { FetchLane, RawItem, TimeWindow } from '../types';
import { TregBalanceError } from '../types';

const TREG_BASE = process.env.TREG_BASE_URL ?? 'https://treg.superdesign.dev';
const TREG_TOKEN = process.env.TREG_TOKEN ?? '';

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

interface Treg402Body {
  balance_micro: number;
  estimated_cost_micro: number;
  topup_url: string;
}

/**
 * Panggil satu tool treg lewat CLI-style endpoint id, mis. "tikhub.tiktok.trending".
 * `params` adalah query params sesuai dokumentasi tool tsb (lihat `treg catalog get <id>`).
 */
async function callTregTool(toolId: string, params: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${TREG_BASE}/call/${toolId}?${qs}`, {
      headers: { 'X-Treg-Token': TREG_TOKEN },
      signal: controller.signal,
    });
    if (res.status === 402) {
      const body = (await res.json()) as Treg402Body;
      throw new TregBalanceError(body.balance_micro, body.estimated_cost_micro, body.topup_url);
    }
    if (!res.ok) {
      throw new Error(`treg ${toolId} error ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// TODO Fase 0: ganti dengan tool id nyata hasil `treg catalog search "trends"` /
// "social listening" — id di bawah ini contoh ilustrasi, BUKAN id yang sudah diverifikasi ada di catalog.
const TREND_TOOL_ID = 'example-provider.trends.search';

interface TregTrendResultShape {
  url: string;
  title: string;
  summary?: string;
  published_at?: string;
}

export function createTregTrendLane(niche: string, timeoutMs = 15_000): FetchLane {
  return {
    name: 'treg',
    timeoutMs,
    isFree: false,
    estimatedCostMicro: 2_000, // placeholder — ambil angka nyata dari `treg catalog get <id>` saat integrasi
    async fetch(query: string, window: TimeWindow): Promise<RawItem[]> {
      const result = (await callTregTool(TREND_TOOL_ID, {
        query,
        days: String(window.days),
        niche,
      }, timeoutMs)) as { items?: TregTrendResultShape[] };

      return (result.items ?? [])
        .filter((r) => r.url && r.title)
        .map((r) => ({
          id: hashUrl(r.url),
          url: r.url,
          title: r.title,
          snippet: r.summary ?? '',
          source: 'treg' as const,
          publishedAt: r.published_at,
          raw: r,
        }));
    },
  };
}

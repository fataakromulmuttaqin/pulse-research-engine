// src/cache.ts
//
// Kenapa Redis (Upstash), bukan Neon Postgres, untuk cache?
// Pola jev-search memisahkan cache respons (Cloudflare KV, TTL menit-jam)
// dari data terstruktur. Kalau cache ditaruh di Postgres yang sama dengan
// data user/langganan, setiap query fetch-berulang ikut membebani DB utama
// dan bikin migrasi/backup jadi lebih berat dari yang perlu.
//
// Upstash dipilih karena REST-based (cocok untuk Vercel serverless/edge,
// tidak perlu koneksi TCP persisten seperti ioredis).

import { createHash } from 'crypto';
import type { LaneName, RawItem, TimeWindow } from './types';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

function cacheKey(lane: LaneName, query: string, window: TimeWindow): string {
  const hash = createHash('sha256').update(`${lane}:${query.toLowerCase().trim()}:${window.days}`).digest('hex');
  return `lane:${lane}:${hash}`;
}

/**
 * TTL berbeda per jendela waktu — jendela 7 hari lebih volatile jadi TTL
 * pendek; jendela 30 hari lebih stabil jadi boleh lebih lama.
 * Sesuaikan angka ini setelah Fase 0 (§ Risiko: "kalibrasi manual").
 */
function ttlSecondsFor(window: TimeWindow): number {
  return window.days <= 7 ? 10 * 60 : 6 * 60 * 60; // 10 menit vs 6 jam
}

async function redisCommand<T>(command: (string | number)[]): Promise<T> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN belum diset');
  }
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error(`Upstash error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { result: T };
  return data.result;
}

export async function getCached(lane: LaneName, query: string, window: TimeWindow): Promise<RawItem[] | null> {
  try {
    const raw = await redisCommand<string | null>(['GET', cacheKey(lane, query, window)]);
    return raw ? (JSON.parse(raw) as RawItem[]) : null;
  } catch {
    // Cache gagal (Upstash down, dsb) TIDAK BOLEH menggagalkan pipeline —
    // anggap saja cache-miss dan lanjut fetch langsung ke lane.
    return null;
  }
}

export async function setCached(lane: LaneName, query: string, window: TimeWindow, items: RawItem[]): Promise<void> {
  // Aturan penting dari jev-search: hanya cache hasil sukses DAN tidak kosong.
  // Hasil kosong sering berarti rate-limit/error sesaat, bukan "memang tidak ada data" —
  // kalau di-cache, kita bisa terkunci 6 jam menampilkan brief kosong ke user.
  if (items.length === 0) return;
  try {
    await redisCommand(['SET', cacheKey(lane, query, window), JSON.stringify(items), 'EX', ttlSecondsFor(window)]);
  } catch {
    // Gagal menulis cache juga bukan alasan menggagalkan request user.
  }
}

// src/lanes/search1api.ts
//
// Implementasi FetchLane untuk Search1API. Satu file per "service" (news, youtube,
// reddit, x) via factory function — bukan 4 file terpisah — supaya perubahan
// mapping engine (lihat README Search1API: search_service per vertical) tidak
// tersebar di banyak tempat.

import { createHash } from 'crypto';
import type { FetchLane, LaneName, RawItem, TimeWindow } from '../types';

const SEARCH1API_KEY = process.env.SEARCH1API_API_KEY ?? '';
const SEARCH1API_BASE = 'https://api.search1api.com';

interface Search1ApiEngineConfig {
  laneName: LaneName;
  searchService: 'news' | 'youtube' | 'reddit' | 'x';
  timeoutMs: number;
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function windowToSearchDays(window: TimeWindow): number {
  return window.days;
}

async function callSearch1Api(
  query: string,
  service: Search1ApiEngineConfig['searchService'],
  days: number,
  timeoutMs: number,
): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SEARCH1API_BASE}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SEARCH1API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, search_service: service, days }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Search1API ${service} error ${res.status}`);
    }
    const data = (await res.json()) as { results?: unknown[] };
    return data.results ?? [];
  } finally {
    clearTimeout(timer);
  }
}

// Bentuk hasil mentah Search1API belum diverifikasi 1:1 di sini — sesuaikan
// field mapping ini dengan payload asli saat integrasi (lihat catatan TODO).
interface Search1ApiResultShape {
  link: string;
  title: string;
  snippet: string;
  date?: string;
}

function toRawItem(raw: unknown, lane: LaneName): RawItem | null {
  const r = raw as Partial<Search1ApiResultShape>;
  if (!r.link || !r.title) return null; // TODO: log item yang di-drop untuk kalibrasi Fase 0
  return {
    id: hashUrl(r.link),
    url: r.link,
    title: r.title,
    snippet: r.snippet ?? '',
    source: lane,
    publishedAt: r.date,
    raw,
  };
}

export function createSearch1ApiLane(config: Search1ApiEngineConfig): FetchLane {
  return {
    name: config.laneName,
    timeoutMs: config.timeoutMs,
    isFree: true, // Search1API free-tier; ganti ke false + estimatedCostMicro kalau pakai kuota berbayar
    estimatedCostMicro: 0,
    async fetch(query: string, window: TimeWindow): Promise<RawItem[]> {
      const raw = await callSearch1Api(query, config.searchService, windowToSearchDays(window), config.timeoutMs);
      return raw.map((r) => toRawItem(r, config.laneName)).filter((x): x is RawItem => x !== null);
    },
  };
}

// Lane siap-pakai untuk Modul A (News, YouTube) — tambah reddit/x saat dibutuhkan modul lain.
export const newsLane = createSearch1ApiLane({ laneName: 'news', searchService: 'news', timeoutMs: 15_000 });
export const youtubeLane = createSearch1ApiLane({ laneName: 'youtube', searchService: 'youtube', timeoutMs: 15_000 });

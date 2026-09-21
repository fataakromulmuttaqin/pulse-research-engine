// src/merge.ts
// Dedupe by URL across lanes — item yang sama muncul di 2 lane (mis. artikel
// yang dibahas di News dan di-share di X) hanya dihitung sekali, prioritaskan
// item dengan snippet lebih lengkap.

import type { LaneResult, RawItem } from './types';

export function mergeLaneResults(results: LaneResult[]): RawItem[] {
  const byUrl = new Map<string, RawItem>();
  for (const result of results) {
    for (const item of result.items) {
      const existing = byUrl.get(item.url);
      if (!existing || item.snippet.length > existing.snippet.length) {
        byUrl.set(item.url, item);
      }
    }
  }
  return Array.from(byUrl.values());
}

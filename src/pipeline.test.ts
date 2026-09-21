// src/pipeline.test.ts
//
// Pola dari jev-search/test/: pipeline dites dengan lane PALSU (mock),
// tidak pernah memanggil Search1API/Treg/Gemini asli — supaya CI tidak
// menghabiskan kredit berbayar dan tidak flaky karena jaringan.
// Jalankan dengan: npm test (vitest)

import { describe, expect, it, vi } from 'vitest';
import { InMemoryLedgerStore, PLAN_QUOTAS } from './ledger';
import { runResearch } from './pipeline';
import type { FetchLane } from './types';

vi.mock('./scoring', () => ({
  scoreItems: async (items: any[]) =>
    items.map((i) => ({ ...i, relevance: 0.8, momentum: 0.5, freshness: 0.9, score: 0.7, scoreStatus: 'ok' as const })),
}));

vi.mock('./cache', () => ({
  getCached: async () => null,
  setCached: async () => undefined,
}));

function fakeLane(name: FetchLane['name'], behavior: 'ok' | 'fail' | 'slow'): FetchLane {
  return {
    name,
    timeoutMs: 200,
    isFree: true,
    estimatedCostMicro: 0,
    async fetch() {
      if (behavior === 'fail') throw new Error('simulated failure');
      if (behavior === 'slow') await new Promise((r) => setTimeout(r, 5000));
      return [{ id: '1', url: `https://example.com/${name}`, title: `Item ${name}`, snippet: 'x', source: name }];
    },
  };
}

describe('runResearch', () => {
  it('lane gagal tidak menggagalkan seluruh brief', async () => {
    const lanes = [fakeLane('news', 'ok'), fakeLane('reddit', 'fail')];
    const brief = await runResearch(
      { userId: 'u1', niche: 'gadget', window: { days: 7 }, lanes },
      { store: new InMemoryLedgerStore(), quota: PLAN_QUOTAS.starter },
    );

    expect(brief.items).toHaveLength(1); // hanya item dari lane 'news'
    const reddit = brief.laneResults.find((r) => r.lane === 'reddit');
    expect(reddit?.status).toBe('failed');
  });

  it('lane yang melebihi overall deadline ditandai failed, bukan menggantung', async () => {
    const lanes = [fakeLane('news', 'ok'), fakeLane('x', 'slow')];
    const brief = await runResearch(
      { userId: 'u1', niche: 'gadget', window: { days: 7 }, lanes, overallTimeoutMs: 300 },
      { store: new InMemoryLedgerStore(), quota: PLAN_QUOTAS.starter },
    );

    const slow = brief.laneResults.find((r) => r.lane === 'x');
    expect(slow?.status).toBe('failed');
  });
});

// === Fase 0.5: parse yt-dlp keyless lane (tanpa call asli / tanpa API key) ===
import { parseYtdlpStdout } from './lanes/ytdlp';

describe('parseYtdlpStdout', () => {
  it('mem-parse JSON per baris, skip baris noise, dan memetakan view_count', () => {
    const stdout = [
      '[download] getting 3 results', // noise → skip
      JSON.stringify({ title: 'Review X', id: 'abc123', channel: 'Chan', view_count: 1234 }),
      'warning: something',           // noise → skip
      JSON.stringify({ title: 'Tanpa channel', url: 'https://youtu.be/xyz' }),
      'bukan json{{{',                // JSON invalid → skip, tidak crash
      JSON.stringify({ no_title: true }), // tanpa title → skip
    ].join('\n');
    const items = parseYtdlpStdout(stdout);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'Review X', id: 'abc123', source: 'youtube' });
    expect(items[0].snippet).toContain('1234 views');
    expect(items[1]).toMatchObject({ url: 'https://youtu.be/xyz' });
  });

  it('stdout kosong → array kosong (lane yang melempar error sendiri)', () => {
    expect(parseYtdlpStdout('')).toHaveLength(0);
  });
});

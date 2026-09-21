// src/lanes/ytdlp.ts
// Lane YouTube KEYLESS — memanggil yt-dlp (binary di HOST, bukan API berbayar).
// Kenapa ini lane pertama Fase 0.5: nol biaya, tanpa rate-limit provider,
// dan memvalidasi seluruh pipeline (cache → merge → scoring) tanpa kunci apa pun.
//
// Prasyarat runtime: yt-dlp tersedia (PATH host, atau via docker exec pada
// container yang sudah punya — lihat makeYtdlpLane dari env YTDLP_DOCKER).
// Catatan 22 Sep 2026: ytsearchdate TIDAK didukung saat yt-dlp memakai
// client 'requests' — pakai `ytsearch{N}:` saja. Flat-playlist tetap
// mengembalikan view_count (sinyal momentum gratis).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FetchLane, RawItem, TimeWindow } from '../types';

const execFileP = promisify(execFile);

export interface YtdlpLaneOptions {
  /** Query tambahan per niche, sudah termasuk kata kunci pencarian. */
  results?: number;
  /** Jalankan via `docker exec <container>` (mis. container Clapclip). */
  dockerContainer?: string;
  /** Argumen docker sebelum perintah yt-dlp, mis. ['exec','openshorts-backend']. */
  dockerExecArgs?: string[];
  timeoutMs?: number;
  estimatedCostMicro?: number;
}

interface YtdlpFlatEntry {
  title?: string;
  url?: string;
  id?: string;
  channel?: string;
  uploader?: string;
  view_count?: number;
  duration?: number;
}

export function parseYtdlpStdout(stdout: string): RawItem[] {
  const items: RawItem[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue; // skip progress/warning lines
    try {
      const e = JSON.parse(trimmed) as YtdlpFlatEntry;
      if (!e.title || (!e.url && !e.id)) continue;
      items.push({
        id: e.id ?? e.url!,
        url: e.url ?? `https://youtu.be/${e.id}`,
        title: e.title,
        snippet: `${e.channel ?? e.uploader ?? 'YouTube'}${e.view_count ? ` · ${e.view_count} views` : ''}`,
        source: 'youtube',
        raw: { views: e.view_count, duration: e.duration },
      });
    } catch {
      // baris bukan JSON valid → skip, jangan jatuhkan lane
    }
  }
  return items;
}

export function makeYtdlpLane(opts: YtdlpLaneOptions = {}): FetchLane {
  const results = opts.results ?? 15;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const run = (args: string[]) =>
    opts.dockerContainer
      ? execFileP(opts.dockerContainer, [...(opts.dockerExecArgs ?? []), 'yt-dlp', ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
      : execFileP('yt-dlp', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });

  return {
    name: 'youtube',
    isFree: true,
    timeoutMs,
    estimatedCostMicro: opts.estimatedCostMicro ?? 0,
    async fetch(query: string, _window: TimeWindow): Promise<RawItem[]> {
      const { stdout } = await run(['--flat-playlist', '--dump-json', `ytsearch${results}:${query}`]);
      const items = parseYtdlpStdout(stdout);
      if (items.length === 0) throw new Error('yt-dlp mengembalikan 0 item');
      return items;
    },
  };
}

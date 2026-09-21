// src/scoring.ts
//
// Titik rapuh nomor satu di pipeline seperti ini: LLM diminta mengembalikan
// angka 0..1 secara freeform gampang menghasilkan JSON tidak valid, field
// hilang, atau angka di luar rentang. Aturan di sini:
//   1. Paksa structured output (JSON mode) dengan skema eksplisit.
//   2. Validasi dengan Zod sebelum dipakai.
//   3. Gagal parse -> retry SEKALI dengan instruksi lebih ketat.
//   4. Gagal lagi -> beri skor default rendah + scoreStatus 'unscored'.
//      JANGAN pernah melempar error yang menggagalkan seluruh batch brief.

import { z } from 'zod';
import type { RawItem, ScoredItem } from './types';

const ScoreSchema = z.object({
  relevance: z.number().min(0).max(1),
  momentum: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
});

type ScoreResult = z.infer<typeof ScoreSchema>;

// Bobot skor final — HARUS dikalibrasi ulang di Fase 0 dengan ground truth
// (apakah topik yang diberi skor tinggi memang naik 3-7 hari kemudian, §8 blueprint).
export const SCORE_WEIGHTS = { relevance: 0.5, momentum: 0.3, freshness: 0.2 } as const;

function computeFinalScore(s: ScoreResult): number {
  return s.relevance * SCORE_WEIGHTS.relevance + s.momentum * SCORE_WEIGHTS.momentum + s.freshness * SCORE_WEIGHTS.freshness;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const GEMINI_MODEL = 'gemini-2.0-flash'; // ganti sesuai model yang tersedia saat implementasi

function buildPrompt(item: RawItem, niche: string, strict: boolean): string {
  const base = `Niche: "${niche}"\nJudul: "${item.title}"\nCuplikan: "${item.snippet}"\n\nNilai item ini untuk brief riset tren harian.`;
  const schema = `Balas HANYA JSON valid, tanpa teks lain, format persis:\n{"relevance": <0..1>, "momentum": <0..1>, "freshness": <0..1>}`;
  return strict ? `${base}\n\nPENTING: keluaran HARUS JSON murni, tanpa markdown, tanpa penjelasan.\n${schema}` : `${base}\n\n${schema}`;
}

async function callGeminiJson(prompt: string): Promise<unknown> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return JSON.parse(text);
}

async function scoreOneItem(item: RawItem, niche: string): Promise<ScoreResult | null> {
  for (const strict of [false, true]) {
    try {
      const json = await callGeminiJson(buildPrompt(item, niche, strict));
      const parsed = ScoreSchema.safeParse(json);
      if (parsed.success) return parsed.data;
    } catch {
      // lanjut ke percobaan berikutnya (strict=true), atau keluar loop kalau sudah percobaan terakhir
    }
  }
  return null; // dua percobaan gagal -> caller memberi skor default
}

/**
 * Skor sekumpulan item. Item yang gagal discore tetap muncul di hasil
 * (scoreStatus: 'unscored', score rendah) — TIDAK di-drop diam-diam, supaya
 * masih terlihat di UI/QA kalau scoring sedang bermasalah.
 */
export async function scoreItems(items: RawItem[], niche: string): Promise<ScoredItem[]> {
  const results = await Promise.all(
    items.map(async (item) => {
      const s = await scoreOneItem(item, niche);
      if (s) {
        return { ...item, ...s, score: computeFinalScore(s), scoreStatus: 'ok' as const };
      }
      return { ...item, relevance: 0, momentum: 0, freshness: 0, score: 0, scoreStatus: 'unscored' as const };
    }),
  );
  return results;
}

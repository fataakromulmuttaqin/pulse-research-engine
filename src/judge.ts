// src/judge.ts
// "Judge" = model yang memberi skor relevansi/momentum/freshness per item.
// Urutan provider (Fase 0.5+):
//   1. typesafe/jev via Vercel AI Gateway — gratis (tanpa charge token, free tier
//      rate-limited) — aktif HANYA kalau VERCEL_AI_GATEWAY_KEY diset.
//   2. Gemini (multi-model fallback) — path yang sudah teruji.
// Keduanya dipanggil dengan structured output; pemanggil tidak tahu provider mana
// yang menjawab (abstraksi §8 blueprint: dependency bisa ditukar tanpa ubah modul).
import { z } from 'zod';

export const JudgeSchema = z.object({
  relevance: z.number().min(0).max(1),
  momentum: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
});

export type JudgeResult = z.infer<typeof JudgeSchema>;

const GATEWAY_KEY = process.env.VERCEL_AI_GATEWAY_KEY ?? '';
const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const JEV_MODEL = 'typesafe/jev';

function buildJudgePrompt(item: { title: string; snippet?: string }, niche: string, strict: boolean): string {
  const base = `Niche: "${niche}"\nJudul: "${item.title}"\nCuplikan: "${item.snippet ?? ''}"\n\nNilai item ini untuk brief riset tren harian.`;
  const schema = 'Balas HANYA JSON valid: {"relevance": <0..1>, "momentum": <0..1>, "freshness": <0..1>}';
  return strict ? `${base}\n\nPENTING: JSON murni tanpa teks lain.\n${schema}` : `${base}\n\n${schema}`;
}

async function callOpenAiStyle(url: string, key: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status} (${model})`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

export async function judgeItem(
  item: { title: string; snippet?: string },
  niche: string,
): Promise<JudgeResult | null> {
  for (const strict of [false, true]) {
    const prompt = buildJudgePrompt(item, niche, strict);
    // 1. Jev via Vercel AI Gateway — kalau kredensialnya ada.
    if (GATEWAY_KEY) {
      try {
        const text = await callOpenAiStyle(GATEWAY_URL, GATEWAY_KEY, JEV_MODEL, prompt);
        const parsed = JudgeSchema.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
      } catch {
        // 429 rate-limit free tier atau JSON rusak → fallback di bawah
      }
    }
    // 2. Gemini multi-model — path fallback yang sudah teruji di scoring.ts.
    try {
      const { callGeminiJudge } = await import('./scoring');
      const viaGemini = await callGeminiJudge(prompt);
      const parsed = JudgeSchema.safeParse(viaGemini);
      if (parsed.success) return parsed.data;
    } catch {
      // lanjut ke percobaan strict berikutnya
    }
  }
  return null; // dua provider × dua percobaan gagal → caller beri status 'unscored'
}

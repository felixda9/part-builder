// Nano Banana (Gemini image models) through the Interactions API (beta - keep all API details
// in this file). Docs: https://ai.google.dev/gemini-api/docs/image-generation

import { GoogleGenAI } from '@google/genai';
import { log } from './paths';

export const MODELS = {
  flash: 'gemini-nano-banana-2.1',
  pro: 'gemini-3-pro-image',
} as const;

/** USD per image (Oct 2026 pricing page). */
export const PRICE: Record<string, Record<string, number>> = {
  'gemini-nano-banana-2.1': { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
  'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
};

export interface RefInput {
  label: string; // what the image is, e.g. "HERO DESIGN"
  data: Buffer;
  mime: string;
}

export interface GeminiRequest {
  prompt: string;
  refs?: RefInput[];
  aspectRatio?: string;
  imageSize?: '1K' | '2K' | '4K';
  model?: string;
  previousInteractionId?: string;
  tag?: string;
}

export interface GeminiResult {
  image: Buffer;
  mime: string;
  interactionId: string | null;
  text: string;
  costUsd: number;
  model: string;
}

let client: GoogleGenAI | null = null;

export function hasApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function getClient(): GoogleGenAI {
  if (!hasApiKey()) throw new Error('No Gemini API key. Put GEMINI_API_KEY=... in .env (see .env.example) and restart the MCP server.');
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function geminiGenerate(req: GeminiRequest): Promise<GeminiResult> {
  const model = req.model ?? MODELS.flash;
  const size = req.imageSize ?? '1K';
  const input: ({ type: 'text'; text: string } | { type: 'image'; mime_type: string; data: string })[] = [];
  for (const r of req.refs ?? []) {
    input.push({ type: 'text', text: `${r.label}:` });
    input.push({ type: 'image', mime_type: r.mime, data: r.data.toString('base64') });
  }
  input.push({ type: 'text', text: req.prompt });

  const params = {
    model,
    input,
    response_format: { type: 'image' as const, aspect_ratio: req.aspectRatio ?? '1:1', image_size: size },
    ...(req.previousInteractionId ? { previous_interaction_id: req.previousInteractionId } : {}),
  };

  let lastErr: unknown;
  for (const wait of [0, 3000, 8000, 20000]) {
    if (wait) await sleep(wait);
    try {
      // The SDK's overloads are strict about literal unions; the request shape follows the docs.
      const it = await getClient().interactions.create(params as never) as unknown as {
        id: string; output_image?: { data?: string; mime_type?: string }; output_text?: string;
      };
      const data = it.output_image?.data;
      if (!data) throw new Error(`no image returned${it.output_text ? `: ${it.output_text.slice(0, 300)}` : ''}`);
      return {
        image: Buffer.from(data, 'base64'), mime: it.output_image?.mime_type ?? 'image/png',
        interactionId: it.id ?? null, text: it.output_text ?? '', costUsd: PRICE[model]?.[size] ?? 0, model,
      };
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const retryable = status === undefined || status === 429 || status >= 500;
      log(`gemini ${req.tag ?? ''} failed (status ${status ?? '?'}): ${(e as Error).message}`);
      if (!retryable) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

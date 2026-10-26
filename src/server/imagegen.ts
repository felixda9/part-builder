// One entry point for image generation, whatever the source:
//   gemini   Nano Banana through the Gemini API (paid per image)
//   comfyui  a ComfyUI server, on this PC or another one (free)
// Default from .env IMAGE_PROVIDER, else whichever is configured (Gemini key, then ComfyUI URL).

import fs from 'node:fs';
import { comfyConfig, comfyGenerate, sizeFor } from './comfy';
import { type RefInput, geminiGenerate, hasApiKey, MODELS } from './gemini';

export type Provider = 'gemini' | 'comfyui';
export const PROVIDERS: Provider[] = ['gemini', 'comfyui'];

export interface GenRequest {
  prompt: string;
  /** Things to avoid; used as the negative prompt for local models. */
  negative?: string;
  refs?: RefInput[];
  aspectRatio?: string;
  imageSize?: '1K' | '2K' | '4K';
  model?: string; // Gemini model id
  previousInteractionId?: string; // Gemini multi-turn edits
  provider?: Provider;
  /** Used instead of any provider when PART_BUILDER_FAKE_IMAGES=1 (offline tests). */
  fake?: () => Promise<Buffer>;
  logFile?: string;
  tag?: string;
  /** ComfyUI only: a specific workflow file in comfy/workflows/, and send the prompt untouched. */
  workflow?: string;
  rawPrompt?: boolean;
  /** ComfyUI only: key color for a workflow's MB_KEY background fill. */
  keyColor?: [number, number, number];
}

export interface GenResult {
  image: Buffer;
  mime: string;
  interactionId: string | null;
  text: string;
  costUsd: number;
  model: string;
  provider: Provider;
}

export const fakeMode = () => process.env.PART_BUILDER_FAKE_IMAGES === '1';

export function defaultProvider(): Provider | null {
  const p = process.env.IMAGE_PROVIDER?.trim().toLowerCase();
  if (p === 'gemini' || p === 'comfyui') return p;
  if (hasApiKey()) return 'gemini';
  if (comfyConfig()) return 'comfyui';
  return null;
}

/** The provider to use, or a helpful error if it isn't set up. */
export function pickProvider(p?: Provider): Provider {
  const chosen = p ?? defaultProvider() ?? (fakeMode() ? 'gemini' : null);
  if (!chosen) {
    throw new Error('No image source configured. In .env set COMFYUI_URL=http://127.0.0.1:8188 (free, your own GPU - see docs/local-gpu.md) or GEMINI_API_KEY=... (paid), then reconnect the MCP server.');
  }
  if (fakeMode()) return chosen;
  if (chosen === 'gemini' && !hasApiKey()) throw new Error('provider gemini needs GEMINI_API_KEY in .env');
  if (chosen === 'comfyui' && !comfyConfig()) throw new Error('provider comfyui needs COMFYUI_URL or COMFYUI_SSH in .env (see docs/local-gpu.md)');
  return chosen;
}

/** Local diffusion models do worse with "avoid X" in the positive prompt; it goes to the negative instead. */
function forDiffusion(prompt: string): string {
  return prompt.split('\n').filter((l) => !/^AVOID:/i.test(l.trim())).join('\n');
}

export async function generateImage(req: GenRequest): Promise<GenResult> {
  const provider = pickProvider(req.provider);
  const size = req.imageSize ?? '1K';
  const started = Date.now();

  if (fakeMode() && req.fake) {
    const image = await req.fake();
    appendLog(req, { provider, model: 'fake', size, cost: 0, ms: Date.now() - started, fake: true });
    return { image, mime: 'image/png', interactionId: null, text: '', costUsd: 0, model: 'fake', provider };
  }

  try {
    if (provider === 'gemini') {
      const r = await geminiGenerate({ ...req, model: req.model ?? MODELS.flash });
      appendLog(req, { provider, model: r.model, size, cost: r.costUsd, ms: Date.now() - started, interaction: r.interactionId });
      return { ...r, provider };
    }
    const cfg = comfyConfig()!;
    const { width, height } = sizeFor(req.aspectRatio ?? '1:1', size, cfg.maxMP);
    const r = await comfyGenerate(cfg, { prompt: req.rawPrompt ? req.prompt : forDiffusion(req.prompt), negative: req.negative, refs: req.refs ?? [], width, height, workflow: req.workflow, rawPrompt: req.rawPrompt, keyColor: req.keyColor });
    const model = `comfyui:${r.workflow}`;
    appendLog(req, { provider, model, size: `${width}x${height}`, cost: 0, ms: Date.now() - started });
    return { image: r.image, mime: 'image/png', interactionId: null, text: '', costUsd: 0, model, provider };
  } catch (e) {
    appendLog(req, { provider, size, cost: 0, ms: Date.now() - started, error: (e as Error).message });
    throw e;
  }
}

function appendLog(req: GenRequest, entry: Record<string, unknown>): void {
  if (!req.logFile) return;
  fs.appendFileSync(req.logFile, JSON.stringify({ time: new Date().toISOString(), tag: req.tag, ...entry }) + '\n');
}

export function totalCost(logFile: string): { calls: number; usd: number; local: number } {
  if (!fs.existsSync(logFile)) return { calls: 0, usd: 0, local: 0 };
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    calls: lines.length,
    usd: Math.round(lines.reduce((s, l) => s + (l.cost ?? 0), 0) * 10000) / 10000,
    local: lines.filter((l) => l.provider === 'comfyui' && !l.error).length,
  };
}

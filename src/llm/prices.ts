// LLM price table (§2.4). Balu edits this file. USD per million tokens.
// Source: Anthropic first-party API list prices (claude-api skill model table, cached 2026-09-25).
// Cache write = 1.25x input (5-minute TTL); cache read as listed per model.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  // Haiku 4.5 cache read = 0.1x input (standard ratio) // verify
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
};

const warned = new Set<string>();

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES[model];
}

/** Estimated USD for a call. Unknown model → warns once per model and returns 0 (§2.4). */
export function estimateUsd(
  model: string,
  usage: LlmUsage,
  warn: (msg: string) => void = (m) => console.warn(m),
): number {
  const p = PRICES[model];
  if (!p) {
    if (!warned.has(model)) {
      warned.add(model);
      warn(`[pramaan/llm] no price for model "${model}" in src/llm/prices.ts; counting as $0`);
    }
    return 0;
  }
  const usd =
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      (usage.cacheReadTokens ?? 0) * p.cacheReadPerMTok +
      (usage.cacheWriteTokens ?? 0) * p.cacheWritePerMTok) /
    1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

/** Test hook: forget which unknown models have been warned about. */
export function resetPriceWarnings(): void {
  warned.clear();
}

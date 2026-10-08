import { beforeEach, describe, expect, it } from 'vitest';
import { PRICES, estimateUsd, resetPriceWarnings } from '../../src/llm/prices.js';

describe('llm prices', () => {
  beforeEach(() => resetPriceWarnings());

  it('has prices for the three default tier models', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']) {
      expect(PRICES[m], m).toBeDefined();
    }
  });

  it('computes USD from input/output tokens', () => {
    const warns: string[] = [];
    const usd = estimateUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 }, (m) => warns.push(m));
    expect(usd).toBeCloseTo(4 + 2, 8);
    expect(warns).toEqual([]);
  });

  it('includes cache read/write tokens', () => {
    const usd = estimateUsd('claude-sonnet-5-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(0.2 + 2.5, 8);
  });

  it('unknown model → $0 and warns exactly once', () => {
    const warns: string[] = [];
    const w = (m: string): void => {
      warns.push(m);
    };
    expect(estimateUsd('claude-unknown-9', { inputTokens: 1000, outputTokens: 1000 }, w)).toBe(0);
    expect(estimateUsd('claude-unknown-9', { inputTokens: 5, outputTokens: 5 }, w)).toBe(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('claude-unknown-9');
  });
});

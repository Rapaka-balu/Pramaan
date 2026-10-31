// Precision per oracle class (§4.7): true positives ÷ all verdicts over the last 50 verdicts of that class.
// A class may auto-file only with ≥ autoFileMinVerdicts verdicts and precision ≥ autoFilePrecision.
import type { LedgerEvent } from '../core/schemas.js';

export const WINDOW = 50;

export interface ClassPrecision {
  oracle: string;
  verdicts: number;
  truePositives: number;
  precision: number;
}

export function precisionByOracle(events: readonly LedgerEvent[]): Map<string, ClassPrecision> {
  const by = new Map<string, string[]>();
  for (const e of events) {
    if (e.type !== 'finding.verdict') continue;
    const oracle = String(e.data['oracle'] ?? '');
    by.set(oracle, [...(by.get(oracle) ?? []), String(e.data['verdict'] ?? '')]);
  }
  const out = new Map<string, ClassPrecision>();
  for (const [oracle, all] of by) {
    const last = all.slice(-WINDOW);
    const tp = last.filter((v) => v === 'true-positive').length;
    out.set(oracle, { oracle, verdicts: last.length, truePositives: tp, precision: last.length === 0 ? 0 : tp / last.length });
  }
  return out;
}

export function mayAutoFile(oracle: string, events: readonly LedgerEvent[], gate: { autoFilePrecision: number; autoFileMinVerdicts: number; shadowMode: boolean }): { ok: boolean; reason: string } {
  if (gate.shadowMode) return { ok: false, reason: 'shadow mode' };
  const p = precisionByOracle(events).get(oracle);
  if (!p || p.verdicts < gate.autoFileMinVerdicts) return { ok: false, reason: `${oracle}: ${p?.verdicts ?? 0}/${gate.autoFileMinVerdicts} verdicts so far` };
  if (p.precision < gate.autoFilePrecision) return { ok: false, reason: `${oracle}: precision ${(p.precision * 100).toFixed(0)}% < ${(gate.autoFilePrecision * 100).toFixed(0)}%` };
  return { ok: true, reason: `${oracle}: precision ${(p.precision * 100).toFixed(0)}% over ${p.verdicts} verdicts` };
}

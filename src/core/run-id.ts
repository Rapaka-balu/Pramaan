import { randomBytes } from 'node:crypto';
import { istParts } from './time.js';

export const RUN_ID_RE = /^\d{8}-\d{4}-[0-9a-f]{4}$/;

const defaultHex = (): string => randomBytes(2).toString('hex');

/** YYYYMMDD-HHmm-<4 hex>, Asia/Kolkata. */
export function newRunId(now: Date = new Date(), randHex: () => string = defaultHex): string {
  const p = istParts(now);
  const hex = randHex().toLowerCase();
  if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error(`newRunId: randHex must return 4 hex chars, got "${hex}"`);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}-${hex}`;
}

/** PRM-<runId> (prefix from safety.runTagPrefix). */
export function runTag(prefix: string, runId: string): string {
  return `${prefix}-${runId}`;
}

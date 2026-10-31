// Classifies an authz replay against the owner's baseline (§8 M4).
// Similarity is *containment*: the share of the baseline's (path=valueHash) pairs that the replay response also
// holds. Jaccard (the spec's wording) misses superset leaks — a cross-tenant list that returns the owner's rows
// plus its own scores ≈ 0.8 — while containment scores it 1.0 (D-014). Array indices, timestamps and run-tagged
// values are ignored. For collections only identifying fields count, so two callers' look-alike numbers
// (e.g. both have 20 days of leave) are not mistaken for a leak.
import { sha1 } from '../core/stable-json.js';
import type { z } from 'zod';
import type { ObservedOutcome } from '../core/schemas.js';

const TIME_KEY = /(^|_)(at|time|timestamp|date)$|At$|Time$|^ts$/;
const TIME_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TAGGED = /^PRM-\d{8}-\d{4}-[0-9a-f]{4}/;
const IDENTIFYING = /^(id|uuid|email|tenant|tenantId|tenant_id|name|employeeName|reason|title|username)$|Id$|_id$/;

export function flattenPairs(v: unknown, opts: { identifyingOnly?: boolean } = {}, path = '$', key = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) flattenPairs(x, opts, `${path}[]`, key, out);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (TIME_KEY.test(k)) continue;
      flattenPairs(x, opts, `${path}.${k}`, k, out);
    }
  } else {
    if (typeof v === 'string' && (TIME_VALUE.test(v) || TAGGED.test(v))) return out;
    if (opts.identifyingOnly && !IDENTIFYING.test(key)) return out;
    out.add(`${path}=${sha1(JSON.stringify(v)).slice(0, 12)}`);
  }
  return out;
}

/** Share of the baseline's pairs present in `actual` (1 = the actor sees everything the owner saw). */
export function containment(baseline: unknown, actual: unknown, identifyingOnly = false): number {
  const base = flattenPairs(baseline, { identifyingOnly });
  if (base.size === 0) return 0;
  const got = flattenPairs(actual, { identifyingOnly });
  let hit = 0;
  for (const p of base) if (got.has(p)) hit += 1;
  return hit / base.size;
}

export interface ReplayResponse {
  status: number;
  body: unknown;
}

export interface Classified {
  outcome: z.infer<typeof ObservedOutcome>;
  similarity?: number;
}

/**
 * - denied: 401, 403, or 404 whose body is unlike the baseline
 * - error: 5xx
 * - same-data: 2xx with similarity ≥ 0.9 (mutations: 2xx = the action succeeded as it did for the owner)
 * - different-data: any other 2xx (normal for filtered list endpoints)
 */
export function classify(
  res: ReplayResponse,
  baseline: unknown,
  kind: { mutating: boolean; collection: boolean },
  threshold = 0.9,
): Classified {
  if (res.status >= 500) return { outcome: 'error' };
  if (res.status === 401 || res.status === 403) return { outcome: 'denied' };
  if (kind.mutating) {
    if (res.status >= 200 && res.status < 300) return { outcome: 'same-data' };
    if (res.status === 404) return { outcome: 'denied' };
    return { outcome: 'error' }; // 400/409 after driving the record to a legal state: not an authz answer
  }
  const similarity = Math.round(containment(baseline, res.body, kind.collection) * 1000) / 1000;
  if (res.status === 404) return similarity >= threshold ? { outcome: 'same-data', similarity } : { outcome: 'denied', similarity };
  if (res.status >= 200 && res.status < 300) {
    return { outcome: similarity >= threshold ? 'same-data' : 'different-data', similarity };
  }
  return { outcome: 'denied', similarity }; // other 4xx (400/405/409/422) refuse the call
}

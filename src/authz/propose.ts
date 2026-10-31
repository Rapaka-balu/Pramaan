// Proposes the expected side of each matrix row (§8 M4). Heuristics only (keyless); the LLM may later adjust a
// cell and add a one-line reason. Every row stays `proposed` until the lead confirms it.
import type { z } from 'zod';
import type { Expectation, ObservedOutcome } from '../core/schemas.js';

type Exp = z.infer<typeof Expectation>;
type Outcome = z.infer<typeof ObservedOutcome>;

const ADMIN_PATH = /(^|\/)(admin|employees|settings|tenants?|payroll)(\/|$)/i;
const PRIVILEGED_ROLE = /admin|manager|hr|lead|approver|owner/;
const PUBLIC_AUTH = /(login|signin|sign-in|register|signup|forgot|reset-password|oauth|auth\/token)/i;

export interface ActorInfo {
  key: string; // role id | 'anonymous' | 'other-tenant:<role>'
  role?: string; // underlying role id
}

export interface RowContext {
  method: string;
  path: string; // template, without query
  ownerRole: string;
  /** Path names a single record ({id} anywhere). */
  record: boolean;
}

export const isPrivileged = (role: string): boolean => PRIVILEGED_ROLE.test(role);

export function proposeCell(row: RowContext, actor: ActorInfo): Exp {
  const mutating = row.method !== 'GET';
  if (actor.key === 'anonymous') return PUBLIC_AUTH.test(row.path) ? 'unknown' : 'deny';
  if (actor.key.startsWith('other-tenant:')) return row.record || mutating ? 'deny' : 'filtered';
  const role = actor.role ?? actor.key;
  const privileged = isPrivileged(role);
  if (ADMIN_PATH.test(row.path) && !/admin/.test(role)) return 'deny';
  if (mutating) return privileged ? 'unknown' : 'deny';
  if (row.record) return privileged ? 'allow' : 'own-only';
  // A collection: a non-privileged caller must only see their own slice; privileged peers are the lead's call.
  return privileged ? 'unknown' : 'filtered';
}

/** Which observed outcomes satisfy an expectation. `filtered` is also met by a refusal: no owner data leaks. */
export const SATISFIES: Record<Exclude<Exp, 'unknown'>, readonly Outcome[]> = {
  allow: ['same-data'],
  deny: ['denied'],
  'own-only': ['denied'],
  filtered: ['different-data', 'denied'],
};

export function violates(expected: Exp, outcome: Outcome): boolean {
  if (expected === 'unknown' || outcome === 'skipped') return false;
  return !SATISFIES[expected].includes(outcome);
}

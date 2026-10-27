// Crawler action safety (§2.3 #2, #3): deny / approval / owned-record rules on UI actions.
import type { AppConfig } from '../core/schemas.js';

type Safety = Pick<AppConfig['safety'], 'denyActionPatterns' | 'requiresApprovalPatterns' | 'approvedActions'>;

/** Deny patterns that the owned-record rule may lift (a row/dialog showing this run's tag). */
export const OWNED_EXEMPT = ['delete', 'cancel', 'approve', 'reject', 'edit', 'update'] as const;

export interface ActionContext {
  name: string; // accessible name
  testid?: string | undefined;
  formAction?: string | undefined; // nearest form's action / id
  dialogTitle?: string | undefined;
  containerText?: string | undefined; // visible text of the nearest row or dialog
}

export type SafetyVerdict =
  | { kind: 'allow' }
  | { kind: 'owned'; pattern: string }
  | { kind: 'deny'; pattern: string }
  | { kind: 'needs-approval'; pattern: string };

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pattern match on a word start, case-insensitive. Spaces in a pattern also match "-" and "_",
 * so "punch in" matches the testid "punch-in-btn". A prefix like "regulariz" matches "Regularize".
 * "lock" does not match "block" (the match must start a word).
 */
export function patternMatches(pattern: string, text: string | undefined): boolean {
  if (!text) return false;
  const body = pattern.trim().split(/\s+/).map(esc).join('[\\s_-]+');
  if (body === '') return false;
  // Word start: string start, a non-letter, or a camelCase hump (approveBtn → "Btn").
  return new RegExp(`(^|[^a-z])${body}`, 'i').test(text) || new RegExp(`[a-z]${body.replace(/^./, (c) => c.toUpperCase())}`).test(text);
}

function firstMatch(patterns: readonly string[], ctx: ActionContext): string | undefined {
  const fields = [ctx.name, ctx.testid, ctx.formAction, ctx.dialogTitle];
  return patterns.find((p) => fields.some((f) => patternMatches(p, f)));
}

export function classifyAction(ctx: ActionContext, safety: Safety, runTag: string): SafetyVerdict {
  const deny = firstMatch(safety.denyActionPatterns, ctx);
  if (deny !== undefined) {
    const exempt = OWNED_EXEMPT.some((p) => patternMatches(p, deny));
    if (exempt && runTag !== '' && (ctx.containerText ?? '').includes(runTag)) return { kind: 'owned', pattern: deny };
    return { kind: 'deny', pattern: deny };
  }
  const approval = firstMatch(safety.requiresApprovalPatterns, ctx);
  if (approval !== undefined) {
    const approved = safety.approvedActions.some(
      (a) => a.toLowerCase() === approval.toLowerCase() || a.toLowerCase() === ctx.name.trim().toLowerCase(),
    );
    return approved ? { kind: 'allow' } : { kind: 'needs-approval', pattern: approval };
  }
  return { kind: 'allow' };
}

// Deterministic names for generated code (§2.2, §8 M6): BDD test names, class and method names.

export const TEST_NAME_RE = /^should_[a-z0-9_]+_when_[a-z0-9_]+$/;

/** "Employee's half-day (0.5)" → "employee_s_half_day_0_5" */
export function slug(s: string, maxWords = 12): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .filter(Boolean)
    .slice(0, maxWords)
    .join('_');
}

const THIRD_PERSON: Record<string, string> = {
  deducts: 'deduct', refunds: 'refund', counts: 'count', creates: 'create', moves: 'move', fires: 'fire', resolves: 'resolve',
  equals: 'equal', applies: 'apply', renders: 'render', shows: 'show', returns: 'return', adds: 'add', removes: 'remove',
  updates: 'update', requires: 'require', rejects: 'reject', allows: 'allow', gets: 'get', has: 'have', happens: 'happen',
  keeps: 'keep', stays: 'stay', matches: 'match', lists: 'list', sends: 'send', changes: 'change', uses: 'use',
};
const VERB = new RegExp(`^(is|are|was|were|happen|${Object.keys(THIRD_PERSON).join('|')})$`);

/**
 * Rule title → should_<action>_when_<condition>:
 *  "An employee cannot approve their own leave"     → should_block_approve_their_own_leave_when_an_employee_tries
 *  "Approving a submitted leave deducts the days"   → should_deduct_the_days_when_approving_a_submitted_leave
 *  "A leave whose end date … is rejected"           → should_be_rejected_when_a_leave_whose_end_date_…
 *  "A leave must request more than 0 days"          → should_request_more_than_0_days_when_a_leave
 */
export function testName(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim().replace(/[.]$/, '');
  const build = (action: string, condition: string): string | undefined => {
    const a = slug(action);
    const c = slug(condition);
    return a && c ? `should_${a}_when_${c}` : undefined;
  };
  const words = t.split(' ');
  const verbAt = (from: number): number => words.findIndex((w, i) => i >= from && VERB.test(w.toLowerCase()));
  let m: RegExpExecArray | null;
  const out =
    ((m = /^(.+?) (?:is|are) (rejected|refused|denied|blocked)$/i.exec(t)) && build(`be_${m[2] ?? ''}`, m[1] ?? '')) ||
    ((m = /^(.+?) (?:cannot|can not|must not|may not|never) (.+)$/i.exec(t)) && build(`block_${m[2] ?? ''}`, `${m[1] ?? ''}_tries`)) ||
    (/ing$/i.test(words[0] ?? '') && verbAt(1) > 0
      ? build(
          [THIRD_PERSON[words[verbAt(1)]?.toLowerCase() ?? ''] ?? words[verbAt(1)] ?? '', ...words.slice(verbAt(1) + 1)].join(' '),
          words.slice(0, verbAt(1)).join(' '),
        )
      : undefined) ||
    ((m = /^(.+?) (?:must|should|always|only) (.+)$/i.exec(t)) && build(/ only /i.test(t) ? `only_${m[2] ?? ''}` : (m[2] ?? ''), m[1] ?? '')) ||
    (verbAt(1) > 0
      ? build(
          [THIRD_PERSON[words[verbAt(1)]?.toLowerCase() ?? ''] ?? words[verbAt(1)] ?? '', ...words.slice(verbAt(1) + 1)].join(' '),
          words.slice(0, verbAt(1)).join(' '),
        )
      : undefined) ||
    build('hold', t);
  return out ?? 'should_hold_when_rule_applies';
}

/** Makes names unique within one file by suffixing _2, _3, … */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n}_${k}`;
  });
}

const words = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
export const camel = (s: string): string => {
  const w = words(s).map((x, i) => (i === 0 ? x.toLowerCase() : x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()));
  const out = w.join('');
  return /^[0-9]/.test(out) ? `v${out}` : out || 'value';
};
export const pascal = (s: string): string => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** "/leaves/{id}" → "LeavesByIdPage"; "/" → "HomePage"; "/leaves?scope" → "LeavesScopePage". */
export function pageClassName(route: string): string {
  const parts = route.replace(/\?/, '/').split('/').filter(Boolean).map((p) => (p === '{id}' ? 'by id' : p));
  return `${pascal(parts.join(' ') || 'home')}Page`;
}

/** Page-object method for a candidate: click<Name> for buttons/links, fill<Label> for fields. */
export function methodName(verb: 'click' | 'fill' | 'select' | 'check', name: string): string {
  return `${verb}${pascal(name).slice(0, 40) || 'Element'}`;
}

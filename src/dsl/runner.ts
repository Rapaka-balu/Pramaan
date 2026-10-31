// Assertion runner (§4.6): arrange → act through the guarded HTTP client, then checks; cleanup always runs.
// Deterministic: a response counts once its body is fully read; no timing-based waits.
import type { Http } from '../core/net.js';
import { decideOwnership } from '../core/ownership-guard.js';
import { parseJsonMaybe } from '../spec/observations.js';
import { evaluateExpr } from './expr.js';
import { evaluateJsonPath } from './jsonpath.js';
import { resolveValue, type ResolveContext } from './resolve.js';
import type { AssertionT } from './validate.js';

export interface RunnerDeps {
  http: Http;
  apiOrigin: string;
  /** Auth headers for an actor key (role id, 'anonymous', 'other-tenant:<role>'). */
  headersFor: (actor: string) => Record<string, string> | undefined;
  runTag: string;
  /** Called for every record a create step made, so the caller's steward can track it. */
  onCreated?: (r: { entity: string; id: string; operation: string; role: string }) => void;
  now?: Date;
}

export interface StepResult {
  id: string;
  actor: string;
  method: string;
  url: string;
  status: number;
  body: unknown;
}
export interface CheckResult {
  ok: boolean;
  message: string;
  actual: unknown;
  expected: unknown;
}
export interface RunResult {
  passed: boolean;
  /** true when the assertion could not run (a step failed to send, a reference was undefined…) — not a check failure */
  aborted: boolean;
  abortReason?: string;
  checks: CheckResult[];
  evidence: StepResult[];
}

type Normalizer = 'none' | 'number' | 'inr' | 'date-in' | 'trim-lower';

export function normalize(v: unknown, n: Normalizer): unknown {
  switch (n) {
    case 'none':
      return v;
    case 'number':
      return typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    case 'inr':
      return typeof v === 'string' ? Number(v.replace(/[₹,\s]|Rs\.?/g, '')) : v;
    case 'date-in': {
      if (typeof v !== 'string') return v;
      const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
      if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
      return v.trim().slice(0, 10);
    }
    case 'trim-lower':
      return typeof v === 'string' ? v.trim().toLowerCase() : v;
  }
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

export function compare(cmp: string, actual: unknown, expected: unknown): boolean {
  switch (cmp) {
    case 'eq':
      return eq(actual, expected);
    case 'neq':
      return !eq(actual, expected);
    case 'gt':
      return num(actual) > num(expected);
    case 'gte':
      return num(actual) >= num(expected);
    case 'lt':
      return num(actual) < num(expected);
    case 'lte':
      return num(actual) <= num(expected);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'absent':
      return actual === undefined || actual === null;
    case 'matches':
      return typeof actual === 'string' && typeof expected === 'string' && new RegExp(expected).test(actual);
    case 'contains':
      return typeof actual === 'string' ? typeof expected === 'string' && actual.includes(expected) : Array.isArray(actual) && actual.some((x) => eq(x, expected));
    case 'in':
      return Array.isArray(expected) && expected.some((x) => eq(x, actual));
    default:
      return false;
  }
}

export async function runAssertion(a: AssertionT, deps: RunnerDeps): Promise<RunResult> {
  const ctx: ResolveContext = { data: a.data, cap: {}, runTag: deps.runTag, ...(deps.now ? { now: deps.now } : {}) };
  const results = new Map<string, StepResult>();
  const evidence: StepResult[] = [];
  const owned = new Set<string>();
  const checks: CheckResult[] = [];

  const runStep = async (s: AssertionT['act'][number]): Promise<void> => {
    if (s.kind === 'ui') throw new Error(`${s.id}: UI steps run in the compiled suite (flows), not in the API runner`);
    const pathParams = resolveValue(s.pathParams, ctx) as Record<string, unknown>;
    const query = resolveValue(s.query, ctx) as Record<string, unknown>;
    const body = s.body === undefined ? undefined : resolveValue(s.body, ctx);
    let path = s.op.path;
    for (const [k, v] of Object.entries(pathParams)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    const u = new URL(path, deps.apiOrigin);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    const text = body === undefined ? undefined : JSON.stringify(body);
    const create = s.op.method === 'POST' && !s.op.path.includes('{');
    if (s.op.method !== 'GET') {
      const d = decideOwnership({ method: s.op.method, url: u.toString(), body: text ?? null, isLoginCall: false, createAllowed: create, ownedIds: owned });
      if (!d.allow) throw new Error(`${s.id}: ownership guard: ${d.reason}`);
    }
    const role = s.actor.startsWith('other-tenant:') ? s.actor.slice('other-tenant:'.length) : s.actor;
    const headers = { ...(s.actor === 'anonymous' ? {} : (deps.headersFor(role) ?? {})), ...(text ? { 'content-type': 'application/json' } : {}) };
    const res = await deps.http.request(u.toString(), { method: s.op.method, headers, ...(text ? { body: text } : {}) });
    const parsed = parseJsonMaybe(await res.text(), res.headers.get('content-type') ?? undefined);
    const r: StepResult = { id: s.id, actor: s.actor, method: s.op.method, url: u.toString(), status: res.status, body: parsed };
    results.set(s.id, r);
    evidence.push(r);
    for (const [name, p] of Object.entries(s.capture)) ctx.cap[name] = evaluateJsonPath(p, parsed);
    if (create && res.status >= 200 && res.status < 300) {
      const id = evaluateJsonPath('$.id', parsed);
      if (typeof id === 'string' || typeof id === 'number') {
        owned.add(String(id));
        deps.onCreated?.({ entity: s.op.path.split('/').filter(Boolean).pop() ?? 'record', id: String(id), operation: `${s.op.method} ${s.op.path}`, role });
      }
    }
  };

  let abortReason: string | undefined;
  try {
    for (const s of [...a.arrange, ...a.act]) await runStep(s);
  } catch (e) {
    abortReason = (e as Error).message;
  }

  if (abortReason === undefined) {
    const lookupRef = (ref: string): unknown => {
      const r = ref.trim();
      if (r.startsWith('data.')) return ctx.data[r.slice(5)];
      if (r.startsWith('cap.')) return ctx.cap[r.slice(4)];
      return undefined;
    };
    for (const c of a.assert) {
      try {
        if (c.kind === 'status') {
          const st = results.get(c.step)?.status;
          checks.push({ ok: st !== undefined && c.oneOf.includes(st), message: c.message, actual: st, expected: c.oneOf });
        } else if (c.kind === 'field') {
          const actual = normalize(evaluateJsonPath(c.path, results.get(c.step)?.body), c.normalize);
          const expected = c.value === undefined ? undefined : normalize(resolveValue(c.value, ctx), c.normalize);
          checks.push({ ok: compare(c.cmp, actual, expected), message: c.message, actual, expected });
        } else if (c.kind === 'delta') {
          const before = num(evaluateJsonPath(c.path, results.get(c.before)?.body));
          const after = num(evaluateJsonPath(c.path, results.get(c.after)?.body));
          const expected = evaluateExpr(c.expected, lookupRef);
          const actual = after - before;
          checks.push({ ok: Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, message: c.message, actual, expected });
        } else {
          const vals = c.refs.map((r) => normalize(evaluateJsonPath(r.path, results.get(r.step)?.body), c.normalize));
          checks.push({ ok: vals.every((v) => eq(v, vals[0])) && vals[0] !== undefined, message: c.message, actual: vals, expected: 'all equal' });
        }
      } catch (e) {
        checks.push({ ok: false, message: c.message, actual: `error: ${(e as Error).message}`, expected: undefined });
      }
    }
  }

  // Cleanup always runs, even after an aborted step; its failures never change the verdict.
  for (const s of a.cleanup) {
    try {
      await runStep(s);
    } catch {
      // a cleanup failure is visible in evidence (or absent from it); the steward's teardown is the backstop
    }
  }
  const aborted = abortReason !== undefined;
  return { passed: !aborted && checks.length > 0 && checks.every((c) => c.ok), aborted, ...(abortReason !== undefined ? { abortReason } : {}), checks, evidence };
}

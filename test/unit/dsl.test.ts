import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Http } from '../../src/core/net.js';
import { evaluateExpr, ExprError } from '../../src/dsl/expr.js';
import { evaluateJsonPath, JsonPathError, parseJsonPath } from '../../src/dsl/jsonpath.js';
import { capRefs, resolveValue } from '../../src/dsl/resolve.js';
import { compare, normalize, runAssertion } from '../../src/dsl/runner.js';
import { validateAssertion } from '../../src/dsl/validate.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join('test', 'fixtures', 'dsl', name), 'utf8'));
const OPS = new Set(['GET /api/leave-balance', 'POST /api/leaves', 'POST /api/leaves/{id}/approve', 'POST /api/leaves/{id}/cancel']);
const doc = { a: { b: [1, 2, 3], 'x y': 'q' }, items: [{ id: 1, tags: ['p'] }, { id: 2 }, { name: 'n' }], s: 'hello' };

describe('JSONPath subset', () => {
  it.each([
    ['$', doc],
    ['$.a.b', [1, 2, 3]],
    ["$.a['x y']", 'q'],
    ['$.a["x y"]', 'q'],
    ['$.a.b[0]', 1],
    ['$.a.b[-1]', 3],
    ['$.items[*].id', [1, 2]],
    ['$.a.b.length()', 3],
    ['$.s.length()', 5],
    ['$.items[*]', doc.items],
  ])('%s', (path, expected) => {
    expect(evaluateJsonPath(path, doc)).toEqual(expected);
  });
  it('returns undefined for missing keys and out-of-range indices', () => {
    expect(evaluateJsonPath('$.nope', doc)).toBeUndefined();
    expect(evaluateJsonPath('$.a.b[9]', doc)).toBeUndefined();
    expect(evaluateJsonPath('$.s.x', doc)).toBeUndefined();
  });
  it.each(['a.b', '$..a', '$.a[?(@.x)]', '$.a[0:2]', '$.a.keys()', '$.a.length().x', '$.a[', '$ a'])('rejects %s', (p) => {
    expect(() => parseJsonPath(p)).toThrow(JsonPathError);
  });
});

describe('expressions', () => {
  const refs: Record<string, unknown> = { 'data.days': 2, 'cap.from': '2026-11-03', 'cap.to': '2026-11-05', 'data.s': '4' };
  const ev = (src: string): number => evaluateExpr(src, (r) => refs[r]);
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['-${data.days}', -2],
    ['--3', 3],
    ['10 / 4', 2.5],
    ['${data.days} * 0.5 - 1', 0],
    ['round(2.345, 2)', 2.35],
    ['round(2.5)', 3],
    ['floor(-1.5)', -2],
    ['ceil(1.1)', 2],
    ['abs(-3)', 3],
    ['min(4, 2, 9)', 2],
    ['max(4, 2, 9)', 9],
    ['days(${cap.from}, ${cap.to})', 3],
    ['days(${cap.from}, ${cap.from})', 1],
    ['${data.s} + 1', 5],
  ])('%s = %d', (src, expected) => {
    expect(ev(src)).toBeCloseTo(expected);
  });
  it('days() uses the Asia/Kolkata date of a date-time', () => {
    expect(evaluateExpr('days(${a}, ${b})', (r) => ({ a: '2026-11-02T19:00:00Z', b: '2026-11-03' })[r])).toBe(1);
  });
  it.each(['1 / 0', '1 +', '(1', 'foo(1)', '${missing} + 1', 'round()', 'days(1, 2)', '1 $ 2'])('errors on %s', (src) => {
    expect(() => ev(src)).toThrow(ExprError);
  });
});

describe('references', () => {
  const ctx = { data: { days: 2, name: 'x' }, cap: { leaveId: 7 }, runTag: 'PRM-20261031-1800-abcd', now: new Date('2026-10-31T10:00:00Z') };
  it('keeps the type of a lone reference', () => {
    expect(resolveValue('${data.days}', ctx)).toBe(2);
    expect(resolveValue({ id: '${cap.leaveId}' }, ctx)).toEqual({ id: 7 });
  });
  it('stringifies references inside mixed text', () => {
    expect(resolveValue('${run.tag} R-012 ${data.days}', ctx)).toBe('PRM-20261031-1800-abcd R-012 2');
  });
  it('resolves today and today±N in IST', () => {
    expect(resolveValue(['${today}', '${today+7}', '${today-1}'], ctx)).toEqual(['2026-10-31', '2026-11-07', '2026-10-30']);
  });
  it('throws on undefined or unknown references', () => {
    expect(() => resolveValue('${cap.nope}', ctx)).toThrow();
    expect(() => resolveValue('${env.SECRET}', ctx)).toThrow();
  });
  it('lists cap references', () => {
    expect([...capRefs({ a: ['${cap.x}', 'y ${cap.y}'], b: '${data.z}' })]).toEqual(['x', 'y']);
  });
});

describe('normalizers and comparators', () => {
  it.each([
    ['₹1,00,000', 'inr', 100000],
    ['03/11/2026', 'date-in', '2026-11-03'],
    ['2026-11-03T10:00:00Z', 'date-in', '2026-11-03'],
    ['  Approved ', 'trim-lower', 'approved'],
    ['12.5', 'number', 12.5],
  ] as const)('normalize(%s, %s)', (v, n, out) => {
    expect(normalize(v, n)).toEqual(out);
  });
  it.each([
    ['eq', { a: 1 }, { a: 1 }, true],
    ['neq', 1, 2, true],
    ['gt', 3, 2, true],
    ['lte', 2, 2, true],
    ['exists', 0, undefined, true],
    ['absent', null, undefined, true],
    ['matches', 'PRM-1', '^PRM-', true],
    ['contains', [1, 2], 2, true],
    ['contains', 'abc', 'b', true],
    ['in', 'approved', ['approved', 'submitted'], true],
    ['in', 'x', ['a'], false],
  ] as const)('%s', (cmp, a, b, ok) => {
    expect(compare(cmp, a, b)).toBe(ok);
  });
});

describe('validateAssertion', () => {
  it('rejects the §10.1 example with a clear message', () => {
    const r = validateAssertion(fixture('A-012.invalid.json'), OPS);
    expect(r).toEqual({ ok: false, errors: ['assert[1]: expected a Check, got a Step — move balAfter to act'] });
  });
  it('accepts the corrected A-012', () => {
    expect(validateAssertion(fixture('A-012.json'), OPS).ok).toBe(true);
  });
  it('rejects unknown operations, missing path params and uncaptured references', () => {
    const a = fixture('A-012.json') as { act: Record<string, unknown>[] };
    a.act[0] = { kind: 'api', id: 'approve', actor: 'admin', op: { method: 'POST', path: '/api/leaves/{id}/approve' }, pathParams: { id: '${cap.nope}' } };
    a.act.push({ kind: 'api', id: 'x', actor: 'admin', op: { method: 'DELETE', path: '/api/leaves/{id}' } });
    const r = validateAssertion(a, OPS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toMatch(/cap\.nope.*not captured/);
    expect(!r.ok && r.errors.join('\n')).toMatch(/DELETE \/api\/leaves\/\{id\} is not in openapi.observed/);
    expect(!r.ok && r.errors.join('\n')).toMatch(/path param \{id\} has no value/);
  });
  it('rejects checks on unknown steps and bad paths', () => {
    const a = fixture('A-012.json') as { assert: Record<string, unknown>[] };
    a.assert.push({ kind: 'field', step: 'ghost', path: '$..x', cmp: 'exists', message: 'ghost step exists' });
    const r = validateAssertion(a, OPS);
    expect(!r.ok && r.errors.length).toBe(2);
  });
});

// A tiny in-memory leave API for the runner.
function fakeApi(opts: { deductExtra?: number } = {}): Http & { log: string[] } {
  let available = 20;
  let nextId = 10;
  const leaves = new Map<number, { days: number; status: string }>();
  const log: string[] = [];
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    log,
    calls: 0,
    async request(url: string, init?: RequestInit): Promise<Response> {
      const u = new URL(url);
      const m = init?.method ?? 'GET';
      log.push(`${m} ${u.pathname}`);
      if (m === 'GET' && u.pathname === '/api/leave-balance') return json(200, { available });
      if (m === 'POST' && u.pathname === '/api/leaves') {
        const b = JSON.parse(String(init?.body)) as { days: number };
        const id = nextId++;
        leaves.set(id, { days: b.days, status: 'submitted' });
        return json(201, { id, ...b });
      }
      const act = /^\/api\/leaves\/(\d+)\/(approve|cancel)$/.exec(u.pathname);
      const l = act ? leaves.get(Number(act[1])) : undefined;
      if (act && l) {
        if (act[2] === 'approve') {
          available -= l.days + (opts.deductExtra ?? 0);
          l.status = 'approved';
        } else {
          if (l.status === 'approved') available += l.days + (opts.deductExtra ?? 0);
          l.status = 'cancelled';
        }
        return json(200, { id: Number(act[1]), status: l.status });
      }
      return json(404, { error: 'not found' });
    },
  };
}

describe('runAssertion', () => {
  const ok = validateAssertion(fixture('A-012.json'), OPS);
  if (!ok.ok) throw new Error('fixture invalid');
  const deps = (http: Http) => ({ http, apiOrigin: 'http://h', headersFor: () => ({}), runTag: 'PRM-20261031-1800-abcd' });

  it('passes on a correct app and always runs cleanup', async () => {
    const http = fakeApi();
    const r = await runAssertion(ok.assertion, deps(http));
    expect(r.passed, JSON.stringify(r.checks)).toBe(true);
    expect(r.checks[1]).toMatchObject({ ok: true, actual: -2, expected: -2 });
    expect(http.log.at(-1)).toBe('POST /api/leaves/10/cancel');
  });
  it('fails the delta check on an off-by-one deduction', async () => {
    const r = await runAssertion(ok.assertion, deps(fakeApi({ deductExtra: 1 })));
    expect(r.passed).toBe(false);
    expect(r.aborted).toBe(false);
    expect(r.checks[1]).toMatchObject({ ok: false, actual: -3, expected: -2, message: 'available balance should drop by the approved days' });
  });
  it('aborts (cannot run) instead of failing when a step cannot be sent', async () => {
    const http: Http = { calls: 0, request: () => Promise.reject(new Error('ECONNREFUSED')) };
    const r = await runAssertion(ok.assertion, deps(http));
    expect(r).toMatchObject({ passed: false, aborted: true });
    expect(r.checks).toEqual([]);
  });
  it('refuses to mutate a record it did not create', async () => {
    const a = structuredClone(ok.assertion);
    a.act = [{ kind: 'api', id: 'approve', actor: 'admin', op: { method: 'POST', path: '/api/leaves/{id}/approve' }, pathParams: { id: '1' }, query: {}, capture: {} }];
    const r = await runAssertion(a, deps(fakeApi()));
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toMatch(/ownership guard/);
  });
});

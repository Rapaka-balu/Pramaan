import { describe, expect, it } from 'vitest';
import { fileFacts, lintChanges } from '../../src/maintain/expect-lint.js';
import { classifyFailure, type FailureFacts } from '../../src/triage/classify.js';
import { mayAutoFile, precisionByOracle } from '../../src/triage/precision.js';
import { errorClass, normalizeMessage, signature, topUserFrame } from '../../src/triage/signature.js';
import type { LedgerEvent } from '../../src/core/schemas.js';

describe('signature', () => {
  const msg = (n: number, tag: string) =>
    `Error: available balance should drop by the approved days\n\nexpect(received).toBeCloseTo(expected)\nExpected: -2\nReceived: -${n}\nleave ${tag} on 2026-11-0${n}T10:00:00Z at http://localhost:6${n}00/api/leaves/${n}4/approve`;
  it('is stable across runs: numbers, ids, dates, run tags and ports are normalized', () => {
    const a = signature({ testId: 't', message: msg(3, 'PRM-20261031-2100-abcd-x') });
    const b = signature({ testId: 't', message: msg(4, 'PRM-20261101-0900-1234-y') });
    expect(a).toBe(b);
    expect(signature({ testId: 'other', message: msg(3, 'x') })).not.toBe(a);
  });
  it('normalizes messages and finds the user frame', () => {
    expect(normalizeMessage("got 'Asha Rao' at /api/leaves/12")).toBe('got <str> at /api/leaves/<n>');
    expect(errorClass('TimeoutError: locator.click')).toBe('TimeoutError');
    expect(errorClass('expect(received).toBe(expected)')).toBe('AssertionError');
    expect(topUserFrame('at Object.<anonymous> (C:\\suite\\node_modules\\x.js:1:1)\n    at C:\\suite\\specs\\api\\leave.spec.ts:20:5')).toBe('specs/api/leave.spec.ts');
  });
});

describe('classifyFailure', () => {
  const base: FailureFacts = { testId: 't', signature: 's', errors: ['Error: x'], operations: ['GET /api/leaves/{id}'], knownOps: new Set(['GET /api/leaves/{id}']), quarantinedSignatures: new Set(), massFailure: false };
  const c = (x: Partial<FailureFacts>) => classifyFailure({ ...base, ...x }).cls;
  it('applies the spec order', () => {
    expect(c({ quarantinedSignatures: new Set(['s']) })).toBe('flaky-known');
    expect(c({ massFailure: true })).toBe('environment');
    expect(c({ rerun: { runs: 3, passes: 1, errors: [] } })).toBe('flaky');
    const loc = "locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByTestId('apply-leave-btn')";
    expect(c({ errors: [loc], rerun: { runs: 3, passes: 0, errors: [loc, loc, loc] } })).toBe('locator-drift');
    expect(c({ errors: ['Error: HTTP 503 GET http://h/api/leave-balance'], rerun: { runs: 3, passes: 0, errors: ['HTTP 503'] } })).toBe('environment');
    expect(c({ errors: ['Expected: 200\nReceived: 404'], rerun: { runs: 3, passes: 0, errors: ['Received: 404'] } })).toBe('spec-change');
    expect(c({ errors: ['Expected: -2\nReceived: -3'], rerun: { runs: 3, passes: 0, errors: ['Received: -3'] } })).toBe('product-bug-candidate');
  });
  it('a 404 on an operation the spec does not know is not a spec change', () => {
    expect(c({ errors: ['Received: 404'], operations: ['GET /api/unknown'], rerun: { runs: 3, passes: 0, errors: [] } })).toBe('product-bug-candidate');
  });
});

describe('precision gate', () => {
  const v = (oracle: string, verdict: string, i: number): LedgerEvent => ({ ts: `2026-10-31T10:00:${String(i % 60).padStart(2, '0')}.000+05:30`, app: 'demo', runId: 'r', type: 'finding.verdict', actor: 'lead:x', data: { findingId: `F-${i}`, oracle, verdict } });
  const gate = { autoFilePrecision: 0.95, autoFileMinVerdicts: 20, shadowMode: false };
  it('needs enough verdicts and high precision, over the last 50', () => {
    expect(mayAutoFile('authz-matrix', [], gate).ok).toBe(false);
    const good = Array.from({ length: 20 }, (_, i) => v('authz-matrix', 'true-positive', i));
    expect(mayAutoFile('authz-matrix', good, gate).ok).toBe(true);
    expect(mayAutoFile('authz-matrix', [...good, v('authz-matrix', 'false-positive', 99)], gate).ok).toBe(true); // 20/21 = 95.2 %
    expect(mayAutoFile('authz-matrix', [...good, v('authz-matrix', 'false-positive', 98), v('authz-matrix', 'false-positive', 99)], gate).ok).toBe(false);
    const old = Array.from({ length: 10 }, (_, i) => v('consistency', 'false-positive', i));
    const recent = Array.from({ length: 50 }, (_, i) => v('consistency', 'true-positive', 100 + i));
    expect(precisionByOracle([...old, ...recent]).get('consistency')?.precision).toBe(1);
    expect(mayAutoFile('authz-matrix', good, { ...gate, shadowMode: true }).reason).toBe('shadow mode');
  });
});

describe('heal lint', () => {
  const spec = (body: string, title = 'should_x_when_y') => `import { test, expect } from '../fixtures';\ntest('${title}', async ({ page }) => {\n${body}\n});\n`;
  const base = spec("  expect(a, 'm').toBe(1);\n  await expect(page.getByTestId('x'), 'visible').toBeVisible();");
  it('counts expects and matcher strength per test', () => {
    expect(fileFacts(base).tests.get('should_x_when_y')).toEqual({ expects: 2, strong: 2, weak: 0 });
  });
  it('accepts a locator-only change to pages/', () => {
    const page = "export class P { a() { return this.page.getByTestId('old'); } }";
    expect(lintChanges([{ file: 'pages/LeavesApplyPage.ts', base: page, head: page.replace('old', 'new') }], { healPr: true })).toEqual([]);
  });
  it('blocks a crafted heal that weakens an assertion', () => {
    const weakened = spec("  expect(a, 'm').toBeTruthy();\n  await expect(page.getByTestId('x'), 'visible').toBeVisible();");
    const v = lintChanges([{ file: 'specs/api/leave.spec.ts', base, head: weakened }], { healPr: true });
    expect(v).toEqual(['specs/api/leave.spec.ts: a heal may only change pages/', 'specs/api/leave.spec.ts: "should_x_when_y" weakened its matchers (strong 2 → 1, weak 0 → 1)']);
  });
  it.each([
    ['fewer expects', spec("  await expect(page.getByTestId('x'), 'visible').toBeVisible();"), 'has fewer expect() calls (2 → 1)'],
    ['skip added', `${base}test.skip('should_z_when_w', async () => {});\n`, 'test.skip / test.fixme / .only added'],
    ['only added', base.replace("test('", "test.only('"), 'test.skip / test.fixme / .only added'],
    ['wait added', spec("  await page.waitForTimeout(500);\n  expect(a, 'm').toBe(1);\n  await expect(page.getByTestId('x'), 'visible').toBeVisible();"), 'waitForTimeout added'],
    ['test removed', spec("  expect(a, 'm').toBe(1);", 'should_other_when_z'), 'was removed'],
  ])('blocks: %s', (_name, head, want) => {
    expect(lintChanges([{ file: 'specs/api/leave.spec.ts', base, head }], { healPr: false }).join('\n')).toContain(want);
  });
});

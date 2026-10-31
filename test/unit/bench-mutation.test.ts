import { describe, expect, it } from 'vitest';
import { failuresOf, oracleMatches, scoreBug, summarize, type BugRun, type IndexEntry } from '../../src/bench/run.js';
import { fieldOf, planMutants, shapesFromOpenApi, specString, titlesRegex } from '../../src/mutation/faults.js';
import { parseResultsJson, sameFile } from '../../src/triage/parse.js';

const entry = (title: string, x: Partial<IndexEntry> = {}): IndexEntry => ({
  file: 'specs/api/leave.spec.ts',
  title,
  tags: ['@api', '@regression'],
  oracle: 'confirmed-rule',
  operations: [],
  reads: {},
  ruleIds: [],
  ...x,
});

const report = (specs: { title: string; file: string; ok: boolean; message?: string }[]): unknown => ({
  suites: [
    {
      title: 'x',
      specs: [],
      suites: [
        {
          specs: specs.map((s) => ({
            title: s.title,
            file: s.file,
            ok: s.ok,
            tests: [{ results: [{ status: s.ok ? 'passed' : 'failed', errors: s.message ? [{ message: `\u001b[31m${s.message}\u001b[39m` }] : [] }] }],
          })),
        },
      ],
    },
  ],
});

describe('results parser', () => {
  it('walks nested suites, keeps the last status and strips ANSI colours', () => {
    const r = parseResultsJson(report([{ title: 'a', file: 'api\\leave.spec.ts', ok: false, message: 'boom' }, { title: 'b', file: 'ui/smoke.spec.ts', ok: true }]));
    expect(r).toMatchObject([{ title: 'a', file: 'api/leave.spec.ts', ok: false, status: 'failed', errors: ['boom'] }, { title: 'b', ok: true }]);
    expect(sameFile('specs/api/leave.spec.ts', 'api/leave.spec.ts')).toBe(true);
  });
});

describe('bench scoring', () => {
  const index = [
    entry('should_deduct_when_approving', { operations: ['POST /api/leaves', 'POST /api/leaves/{id}/approve', 'GET /api/leave-balance'] }),
    entry('should_return_denied_for_employee2_when_calling_get_api_leaves_id', { file: 'specs/authz/authz-matrix.spec.ts', oracle: 'authz-matrix', operations: ['GET /api/leaves/{id}'] }),
    entry('should_show_the_api_available_when_employee_reloads_dashboard', { file: 'specs/ui/consistency.spec.ts', oracle: 'consistency', operations: ['GET /api/leave-balance', 'GET /dashboard'] }),
  ];
  const fails = (titles: [string, string, string?][]) =>
    failuresOf(parseResultsJson(report(titles.map(([title, file, message]) => ({ title, file, ok: false, ...(message ? { message } : {}) })))), index);

  it('a charter-candidate bug is caught by the confirmed rule its candidate became', () => {
    expect(oracleMatches('charter-candidate', 'confirmed-rule')).toBe(true);
    expect(oracleMatches('confirmed-rule', 'charter-candidate')).toBe(false);
    expect(oracleMatches('authz-matrix', 'consistency')).toBe(false);
  });
  it('hit = oracle match + operation overlap; everything else is a false alarm', () => {
    const f = fails([
      ['should_deduct_when_approving', 'api/leave.spec.ts'],
      ['should_return_denied_for_employee2_when_calling_get_api_leaves_id', 'authz/authz-matrix.spec.ts'],
    ]);
    const s = scoreBug(f, { id: 'balance-off-by-one', category: 'calculation', expectedOracle: 'confirmed-rule', operations: ['POST /api/leaves/{id}/approve', 'GET /api/leave-balance'] });
    expect(s.detected).toBe(true);
    expect(s.hits).toEqual(['api/leave.spec.ts > should_deduct_when_approving']);
    expect(s.falseAlarms).toHaveLength(1);
  });
  it('an implicit-oracle failure counts as implicit, matched on UI routes too', () => {
    const f = fails([['should_show_the_api_available_when_employee_reloads_dashboard', 'ui/consistency.spec.ts', 'implicit oracle: no console errors…']]);
    expect(f[0]?.oracle).toBe('implicit');
    expect(scoreBug(f, { id: 'dashboard-console-error', category: 'implicit', expectedOracle: 'implicit', operations: ['GET /dashboard'] }).detected).toBe(true);
  });
  it('query strings do not block a match (GET /api/leaves?all is GET /api/leaves)', () => {
    const f = failuresOf(parseResultsJson(report([{ title: 'q', file: 'authz/a.spec.ts', ok: false }])), [entry('q', { file: 'specs/authz/a.spec.ts', oracle: 'authz-matrix', operations: ['GET /api/leaves?all'] })]);
    expect(scoreBug(f, { id: 'cross-tenant-list', category: 'tenant-isolation', expectedOracle: 'authz-matrix', operations: ['GET /api/leaves'] }).detected).toBe(true);
  });
  it('summarizes recall, precision and per-oracle precision; every failure on none is a false alarm', () => {
    const runs: BugRun[] = [
      { ...scoreBug([], undefined), durationMs: 1 },
      { bug: 'a', category: 'authz', expectedOracle: 'authz-matrix', detected: true, hits: ['x'], falseAlarms: [], failures: 1, durationMs: 1 },
      { bug: 'b', category: 'calculation', expectedOracle: 'confirmed-rule', detected: false, hits: [], falseAlarms: ['y'], failures: 1, durationMs: 1 },
    ];
    const r = summarize('r', 'demo', runs, new Map([['authz-matrix', { t: 1, f: 0 }], ['confirmed-rule', { t: 0, f: 1 }]]), 3);
    expect(r).toMatchObject({ recall: 0.5, precision: 0.5, falseAlarmsOnNone: 0, recallByCategory: { authz: { detected: 1, total: 1 }, calculation: { detected: 0, total: 1 } } });
    expect(r.precisionByOracle['authz-matrix']?.precision).toBe(1);
  });
});

describe('mutant planning', () => {
  const openapi = {
    paths: {
      '/api/leave-balance': { get: { responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { available: { type: 'integer' }, total: { type: 'integer' } } } } } } } } },
      '/api/leaves': { get: { responses: { '200': { content: { 'application/json': { schema: { type: 'array', items: { properties: { id: { type: 'integer' }, status: { type: 'string' } } } } } } } } } },
    },
  };
  const shapes = shapesFromOpenApi(openapi);

  it('reads field types and list shape from the observed OpenAPI', () => {
    expect(shapes('GET /api/leave-balance')).toEqual({ isList: false, fieldTypes: { available: 'integer', total: 'integer' } });
    expect(shapes('GET /api/leaves')?.isList).toBe(true);
    expect(shapes('GET /nope')).toBeUndefined();
  });
  it('fieldOf', () => {
    expect([fieldOf('$.available'), fieldOf('$[*].status'), fieldOf("$['a b']"), fieldOf('$'), fieldOf('#status')]).toEqual(['available', 'status', 'a b', undefined, undefined]);
  });
  it('plans faults only on fields a test reads, skips +1 on delta-only fields, adds stale-copy when the test writes', () => {
    const t = entry('delta', { operations: ['POST /api/leaves/{id}/approve', 'GET /api/leave-balance'], reads: { 'GET /api/leave-balance': ['~$.available'], 'POST /api/leaves/{id}/approve': ['#status'] } });
    const plan = planMutants([t], shapes);
    expect([...plan.specs.keys()].sort()).toEqual([
      'drop-field:GET /api/leave-balance#available',
      'null-field:GET /api/leave-balance#available',
      'number-times-ten:GET /api/leave-balance#available',
      'stale-copy:GET /api/leave-balance',
      'status-500:GET /api/leave-balance',
      'status-500:POST /api/leaves/{id}/approve',
    ]);
    expect([...plan.robustness.keys()]).toEqual(['delay-2s:GET /api/leave-balance']);
    expect([...plan.specs.keys()].some((k) => k.includes('#total')), 'total is never read').toBe(false);
  });
  it('authz tests (a differential oracle) get status faults only; smoke tests are not mutated; ops can be limited', () => {
    const authz = entry('z', { oracle: 'authz-matrix', reads: { 'GET /api/leaves?all': ['$'] } });
    const smoke = entry('s', { tags: ['@smoke'], reads: { 'GET /api/leaves': ['$'] } });
    expect([...planMutants([authz, smoke], shapes).specs.keys()].sort()).toEqual(['status-403-to-200:GET /api/leaves', 'status-500:GET /api/leaves']);
    expect(planMutants([authz], shapes, ['GET /api/leave-balance']).specs.size).toBe(0);
  });
  it('consistency tests get field faults on the UI channel only; list readers get list faults; owner fields get tenant swaps', () => {
    const c = entry('c', { oracle: 'consistency', reads: { 'GET /api/leave-balance': ['$.available'] } });
    const keys = [...planMutants([c], shapes).specs.keys()];
    expect(keys).toContain('number-plus-one:GET /api/leave-balance#available@ui');
    expect(keys).toContain('stale-copy:GET /api/leave-balance@ui');
    expect(keys.filter((k) => !k.startsWith('status-500')).every((k) => k.endsWith('@ui'))).toBe(true);
    const l = entry('l', { reads: { 'GET /api/leaves': ['$[*].status', '$[*].employeeId'] } });
    const lk = [...planMutants([l], shapes).specs.keys()];
    expect(lk).toEqual(expect.arrayContaining(['empty-list:GET /api/leaves', 'truncate-list:GET /api/leaves', 'swap-tenant-id:GET /api/leaves']));
  });
  it('builds a grep that selects exact titles only', () => {
    const re = new RegExp(titlesRegex(['should_a_when_b']));
    expect(re.test('api/leave.spec.ts leave should_a_when_b @api')).toBe(true);
    expect(re.test('api/leave.spec.ts leave should_a_when_b_2 @api')).toBe(false);
    expect(specString({ kind: 'drop-field', op: 'GET /x', field: 'y' })).toBe('drop-field:GET /x#y');
  });
});

describe('bug activation', () => {
  it('manual activation (HRMS) asks the human and waits', async () => {
    const { activate } = await import('../../src/bench/target.js');
    const asked: string[] = [];
    const t = await activate('hrms', { manual: 'deploy bug B07 to staging' }, { port: 0, ask: async (m) => void asked.push(m) });
    await t.stop();
    expect(asked).toEqual(['deploy bug B07 to staging']);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AppConfig,
  ApiStep,
  Assertion,
  BugCatalog,
  Check,
  Evidence,
  Finding,
  LedgerEvent,
  MatrixRow,
  RoleMatrixFile,
  Rule,
  RulesFile,
  Step,
  UiStep,
} from '../../src/core/schemas.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'assertions', name), 'utf8')) as unknown;

const evidence = { id: 'E-3fa1c2d9', kind: 'response', ref: 'GET /api/leave-balance', excerpt: '{"available": 12}' };
const decision = { by: 'lead:balu', at: '2026-11-03T10:12:00+05:30' };
const rule = {
  id: 'R-012',
  title: "Approving a submitted leave deducts exactly the requested days from the employee's balance",
  kind: 'calculation',
  status: 'confirmed',
  confidence: 0.86,
  source: 'domain-pack',
  evidence: [evidence],
  criticality: 5,
  decision,
};
const apiStep = { kind: 'api', id: 'apply', actor: 'employee', op: { method: 'POST', path: '/api/leaves' }, body: { days: 2 } };
const uiStep = { kind: 'ui', id: 'applyUi', actor: 'employee', flow: 'leave.apply', args: { days: '2' } };
const matrixRow = {
  operation: 'GET /api/leaves/{id}',
  ownerRole: 'employee',
  expected: { employee: 'allow', employee2: 'deny', anonymous: 'deny', 'other-tenant:employee': 'deny' },
  observed: { employee2: { status: 200, outcome: 'same-data', similarity: 1 } },
  status: 'proposed',
};
const appConfig = {
  schemaVersion: 1,
  id: 'demo',
  name: 'Demo HRMS',
  baseUrl: 'http://localhost:4600',
  tenants: [{ id: 'primary', codeEnv: 'DEMO_TENANT_PRIMARY' }],
  roles: [{ id: 'employee', tenant: 'primary', usernameEnv: 'U', passwordEnv: 'P' }],
  login: {},
  safety: { allowedOrigins: ['http://localhost:4600'], denyActionPatterns: ['delete'] },
  output: { repoPath: '../suite' },
};
const finding = {
  id: 'F-0001',
  title: 'employee2 can read employee leave',
  severity: 'S1',
  oracle: 'authz-matrix',
  signature: 'abc123',
  evidence: [evidence],
  reproSteps: ['login as employee2', 'GET /api/leaves/7'],
  status: 'candidate',
  firstSeenRunId: '20261008-1430-ab12',
  lastSeenRunId: '20261008-1430-ab12',
};

type Case = [name: string, schema: z.ZodType, valid: unknown, invalid: unknown];
const cases: Case[] = [
  ['AppConfig', AppConfig, appConfig, { ...appConfig, safety: { ...appConfig.safety, denyActionPatterns: [] } }],
  ['Evidence', Evidence, evidence, { ...evidence, id: 'E-XYZ' }],
  ['Rule', Rule, rule, { ...rule, title: 'too short' }],
  ['RulesFile', RulesFile, { schemaVersion: 1, rules: [rule] }, { schemaVersion: 2, rules: [] }],
  ['MatrixRow', MatrixRow, matrixRow, { ...matrixRow, expected: { Employee: 'allow' } }],
  ['RoleMatrixFile', RoleMatrixFile, { schemaVersion: 1, rows: [matrixRow] }, { schemaVersion: 1, rows: [{ operation: 'x' }] }],
  ['ApiStep', ApiStep, apiStep, { ...apiStep, op: { method: 'GET', path: 'api/leaves' } }],
  ['UiStep', UiStep, uiStep, { ...uiStep, id: 'Bad-Id' }],
  ['Step', Step, uiStep, { ...apiStep, kind: 'shell' }],
  ['Check', Check, { kind: 'status', step: 'apply', oneOf: [201], message: 'leave should be created' }, { kind: 'status', step: 'apply', oneOf: [], message: 'leave should be created' }],
  ['Assertion', Assertion, fixture('A-012.valid.json'), fixture('A-012.invalid.json')],
  ['Finding', Finding, finding, { ...finding, id: 'F-1' }],
  [
    'LedgerEvent',
    LedgerEvent,
    { ts: '2026-10-08T14:03:00.123+05:30', app: 'demo', runId: '20261008-1430-ab12', type: 'run.started', actor: 'pramaan:cli', data: {} },
    { ts: '2026-10-08 14:03', app: 'demo', runId: 'r', type: 'run.started', actor: 'x', data: {} },
  ],
  [
    'BugCatalog',
    BugCatalog,
    { schemaVersion: 1, bugs: [{ id: 'idor-leave-read', category: 'authz', activation: { env: { DEMO_BUGS: 'idor-leave-read' } }, expectedOracle: 'authz-matrix', operations: ['GET /api/leaves/{id}'] }] },
    { schemaVersion: 1, bugs: [{ id: 'x', category: 'authz', activation: {}, expectedOracle: 'nope', operations: [] }] },
  ],
];

describe.each(cases)('%s', (_name, schema, valid, invalid) => {
  it('accepts the valid fixture', () => {
    const r = schema.safeParse(valid);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });
  it('rejects the invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false);
  });
});

describe('specific contract rules', () => {
  it('a confirmed rule without a decision fails', () => {
    const { decision: _d, ...noDecision } = rule;
    const r = Rule.safeParse(noDecision);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? [] : r.error.issues)).toMatch(/confirmed rules need a decision/);
  });

  it('a proposed rule without a decision passes, with defaults filled', () => {
    const { decision: _d, ...noDecision } = rule;
    const r = Rule.parse({ ...noDecision, status: 'proposed' });
    expect(r.version).toBe(1);
    expect(r.assertionIds).toEqual([]);
  });

  it('A-012 invalid fails at assert[1] (a Step where a Check belongs)', () => {
    const r = Assertion.safeParse(fixture('A-012.invalid.json'));
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(paths.some((p) => p.startsWith('assert.1'))).toBe(true);
  });

  it('A-012 valid has balAfter at the end of act and a delta check', () => {
    const a = Assertion.parse(fixture('A-012.valid.json'));
    expect(a.act.at(-1)?.id).toBe('balAfter');
    expect(a.assert.map((c) => c.kind)).toEqual(['status', 'delta']);
  });

  it('AppConfig fills safety defaults', () => {
    const c = AppConfig.parse(appConfig);
    expect(c.safety.maxRps).toBe(2);
    expect(c.safety.runTagPrefix).toBe('PRM');
    expect(c.login.strategy).toBe('form');
    expect(c.budgets).toEqual({ perCommandUsd: 5, compileUsd: 40 });
  });
});

import { describe, expect, it } from 'vitest';
import { classify, containment, flattenPairs } from '../../src/authz/compare.js';
import { confirmAll, contradictions, mergeMatrix, type RoleMatrix } from '../../src/authz/matrix-io.js';
import { proposeCell, violates } from '../../src/authz/propose.js';

const leave = (id: number, employeeId: number, tenant = 'TEST'): Record<string, unknown> => ({
  id, employeeId, tenant, employeeName: `E${employeeId}`, days: 1, status: 'submitted', createdAt: `2026-10-3${id % 10}T10:00:00Z`,
});
const rec = { mutating: false, collection: false };
const coll = { mutating: false, collection: true };

describe('flattenPairs / containment', () => {
  it('ignores array positions, timestamps and run-tagged values', () => {
    const a = flattenPairs([leave(1, 1), { reason: 'PRM-20261031-1700-abcd-x' }]);
    expect([...a].some((p) => p.includes('createdAt'))).toBe(false);
    expect([...a].some((p) => p.startsWith('$[].reason'))).toBe(false);
    expect(containment([leave(1, 1), leave(2, 2)], [leave(2, 2), leave(1, 1)])).toBe(1);
  });
  it('scores a superset leak as full containment', () => {
    expect(containment([leave(1, 1), leave(2, 2)], [leave(1, 1), leave(3, 6, 'TEST2'), leave(2, 2)], true)).toBe(1);
  });
  it('identifying-only mode ignores look-alike numbers', () => {
    expect(containment({ total: 20, used: 0 }, { total: 20, used: 0 }, true)).toBe(0);
    expect(containment([leave(1, 1)], [leave(3, 6, 'TEST2')], true)).toBe(0);
  });
});

describe('classify', () => {
  it('denies 401/403 and a 404 unlike the baseline', () => {
    expect(classify({ status: 401, body: null }, leave(1, 1), rec).outcome).toBe('denied');
    expect(classify({ status: 403, body: { error: 'x' } }, leave(1, 1), rec).outcome).toBe('denied');
    expect(classify({ status: 404, body: { error: 'Leave not found' } }, leave(1, 1), rec).outcome).toBe('denied');
  });
  it('flags 5xx as error', () => {
    expect(classify({ status: 503, body: null }, leave(1, 1), rec).outcome).toBe('error');
  });
  it('same-data at ≥ 0.9 similarity, different-data below', () => {
    expect(classify({ status: 200, body: leave(1, 1) }, leave(1, 1), rec)).toEqual({ outcome: 'same-data', similarity: 1 });
    expect(classify({ status: 200, body: [leave(9, 2)] }, [leave(1, 1)], coll).outcome).toBe('different-data');
  });
  it('treats a successful mutation as same-data and 409 as error', () => {
    const m = { mutating: true, collection: false };
    expect(classify({ status: 200, body: leave(5, 1) }, leave(4, 1), m).outcome).toBe('same-data');
    expect(classify({ status: 404, body: {} }, leave(4, 1), m).outcome).toBe('denied');
    expect(classify({ status: 409, body: {} }, leave(4, 1), m).outcome).toBe('error');
  });
});

describe('proposeCell', () => {
  const row = (method: string, path: string, record: boolean) => ({ method, path, ownerRole: 'employee', record });
  it('denies anonymous except public auth endpoints', () => {
    expect(proposeCell(row('GET', '/api/leaves', false), { key: 'anonymous' })).toBe('deny');
    expect(proposeCell(row('POST', '/api/auth/login', false), { key: 'anonymous' })).toBe('unknown');
  });
  it('other tenants: deny records and writes, filter collections', () => {
    expect(proposeCell(row('GET', '/api/leaves/{id}', true), { key: 'other-tenant:t2-admin', role: 't2-admin' })).toBe('deny');
    expect(proposeCell(row('GET', '/api/leaves', false), { key: 'other-tenant:t2-admin', role: 't2-admin' })).toBe('filtered');
  });
  it('admin paths deny non-admins', () => {
    expect(proposeCell(row('GET', '/api/employees', false), { key: 'employee' })).toBe('deny');
    expect(proposeCell(row('GET', '/api/employees', false), { key: 'manager' })).toBe('deny');
    expect(proposeCell(row('GET', '/api/employees', false), { key: 'admin' })).not.toBe('deny');
  });
  it('record reads: own-only for plain roles, allow for privileged ones', () => {
    expect(proposeCell(row('GET', '/api/leaves/{id}', true), { key: 'employee2' })).toBe('own-only');
    expect(proposeCell(row('GET', '/api/leaves/{id}', true), { key: 'manager' })).toBe('allow');
  });
  it('writes: deny for plain roles, unknown for privileged ones', () => {
    expect(proposeCell(row('POST', '/api/leaves/{id}/approve', true), { key: 'employee' })).toBe('deny');
    expect(proposeCell(row('POST', '/api/leaves/{id}/approve', true), { key: 'manager' })).toBe('unknown');
  });
});

describe('violates', () => {
  it('maps expectations to acceptable outcomes', () => {
    expect(violates('own-only', 'same-data')).toBe(true);
    expect(violates('own-only', 'denied')).toBe(false);
    expect(violates('filtered', 'denied')).toBe(false);
    expect(violates('filtered', 'same-data')).toBe(true);
    expect(violates('deny', 'different-data')).toBe(true);
    expect(violates('allow', 'denied')).toBe(true);
    expect(violates('unknown', 'error')).toBe(false);
    expect(violates('deny', 'skipped')).toBe(false);
  });
});

describe('matrix merge, review and judging', () => {
  const row = (operation: string, status: 'proposed' | 'confirmed', exp: string, outcome: string): RoleMatrix['rows'][number] => ({
    operation,
    ownerRole: 'employee',
    expected: { employee2: exp as 'deny' },
    observed: { employee2: { status: outcome === 'denied' ? 404 : 200, outcome: outcome as 'denied' } },
    status,
    ...(status === 'confirmed' ? { decision: { by: 'lead:balu', at: '2026-10-31T10:00:00+05:30' } } : {}),
  });
  it('keeps decided expectations and takes the fresh observed side', () => {
    const prev: RoleMatrix = { schemaVersion: 1, rows: [row('GET /a', 'confirmed', 'own-only', 'denied'), row('GET /b', 'proposed', 'deny', 'denied')] };
    const fresh: RoleMatrix = { schemaVersion: 1, rows: [row('GET /a', 'proposed', 'allow', 'same-data'), row('GET /b', 'proposed', 'filtered', 'denied')] };
    const m = mergeMatrix(prev, fresh);
    expect(m.rows[0]).toMatchObject({ operation: 'GET /a', status: 'confirmed', expected: { employee2: 'own-only' }, observed: { employee2: { outcome: 'same-data' } } });
    expect(m.rows[1]?.expected['employee2']).toBe('filtered');
  });
  it('only confirmed rows produce findings; proposed ones are questions', () => {
    const m: RoleMatrix = { schemaVersion: 1, rows: [row('GET /a', 'confirmed', 'own-only', 'same-data'), row('GET /b', 'proposed', 'deny', 'same-data')] };
    expect(contradictions(m).map((c) => [c.operation, c.confirmed])).toEqual([['GET /a', true], ['GET /b', false]]);
    expect(contradictions(confirmAll(m, 'lead:test')).every((c) => c.confirmed)).toBe(true);
  });
});

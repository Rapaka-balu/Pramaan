import { describe, expect, it } from 'vitest';
import { buildTemplater } from '../../src/spec/path-normalize.js';
import { inferSchema, leafFields } from '../../src/spec/schema-infer.js';

describe('path templating', () => {
  it('turns id-like segments into {id}', () => {
    const t = buildTemplater(['/api/leaves/4', '/api/leaves/4/cancel']);
    expect(t.template('/api/leaves/12')).toBe('/api/leaves/{id}');
    expect(t.template('/api/leaves/4/cancel')).toBe('/api/leaves/{id}/cancel');
    expect(t.template('/api/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/api/x/{id}');
  });
  it('keeps word segments and static files', () => {
    const t = buildTemplater(['/api/leaves/export.csv', '/api/leaves/apply', '/api/leaves/4']);
    expect(t.template('/api/leaves/export.csv')).toBe('/api/leaves/export.csv');
    expect(t.template('/api/leave-balance')).toBe('/api/leave-balance');
  });
  it('detects a slug position with ≥ 3 distinct values in otherwise-equal paths', () => {
    const paths = ['/api/employees', '/api/employees/asha1/profile', '/api/employees/vikram2/profile', '/api/employees/meera3/profile'];
    const t = buildTemplater(paths);
    expect(t.template('/api/employees/rohan4/profile')).toBe('/api/employees/{id}/profile');
  });
  it('never collapses sibling collections into a param', () => {
    const t = buildTemplater(['/api/leaves', '/api/employees', '/api/attendance', '/api/approvals']);
    expect(t.template('/api/leaves')).toBe('/api/leaves');
  });
  it('does not call 2 distinct values a slug', () => {
    const t = buildTemplater(['/api/reports/daily', '/api/reports/monthly']);
    expect(t.template('/api/reports/daily')).toBe('/api/reports/daily');
  });
  it('names several params uniquely, the last one {id}', () => {
    const t = buildTemplater(['/api/employees/7/leaves/9']);
    expect(t.template('/api/employees/7/leaves/9')).toBe('/api/employees/{employeeId}/leaves/{id}');
  });
});

describe('schema inference', () => {
  it('infers object properties, required keys and formats', () => {
    const s = inferSchema([
      { id: 1, from: '2026-11-03', at: '2026-10-27T14:55:33.215Z', email: 'a@b.in', note: 'x' },
      { id: 2, from: '2026-11-05', at: '2026-10-27T14:55:33Z', email: 'c@d.in' },
    ]);
    expect(s.type).toBe('object');
    expect(s.required).toEqual(['at', 'email', 'from', 'id']);
    expect(s.properties?.['id']).toEqual({ type: 'integer' });
    expect(s.properties?.['from']).toEqual({ type: 'string', format: 'date' });
    expect(s.properties?.['at']?.format).toBe('date-time');
    expect(s.properties?.['email']?.format).toBe('email');
  });
  it('merges conflicting types into a union', () => {
    expect(inferSchema(['a', 1, null]).type).toEqual(['integer', 'null', 'string']);
    expect(inferSchema([1, 1.5]).type).toBe('number');
    expect(inferSchema([{ decidedBy: null }, { decidedBy: 3 }]).properties?.['decidedBy']?.type).toEqual(['integer', 'null']);
  });
  it('drops a format when not every sample matches', () => {
    expect(inferSchema(['2026-11-03', 'soon']).format).toBeUndefined();
  });
  it('infers array items across samples', () => {
    const s = inferSchema([[{ id: 1, status: 'submitted' }], [{ id: 2 }], []]);
    expect(s.type).toBe('array');
    expect(s.items?.required).toEqual(['id']);
  });
  it('lists leaf fields with paths', () => {
    const s = inferSchema([{ a: { b: 1 }, list: [{ c: 'x' }] }]);
    expect(leafFields(s).map((f) => f.path)).toEqual(['a.b', 'list[].c']);
  });
  it('returns an empty schema for no samples', () => {
    expect(inferSchema([undefined])).toEqual({});
  });
});

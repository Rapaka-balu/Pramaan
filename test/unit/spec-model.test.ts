import { describe, expect, it } from 'vitest';
import { inferEntities, jaccard, pathRoot } from '../../src/spec/entities.js';
import { buildApiModel, toOpenApi } from '../../src/spec/har-to-openapi.js';
import { pathTo, retag } from '../../src/spec/lifecycle-probe.js';
import type { Observation } from '../../src/spec/observations.js';
import { docOperations, opKey, scoreAgainstDocs, specUrlFromDocsPage } from '../../src/spec/score-vs-docs.js';
import { inferStateMachine, uiHintsFrom, verbOf } from '../../src/spec/state-machines.js';

let t = 0;
const ob = (role: string, method: string, path: string, status: number, resBody?: unknown, reqBody?: unknown): Observation => ({
  role, method, url: `http://h${path}`, path, query: [], status, resBody, reqBody, ts: ++t, ref: `crawl/${role}/crawl.har#${t}`,
});
const leave = (id: number, status: string): Record<string, unknown> => ({ id, employeeId: 1, from: '2026-11-03', days: 1, reason: 'x', status });

const traffic = (): Observation[] => [
  ob('employee', 'GET', '/api/leaves', 200, [leave(1, 'submitted')]),
  ob('employee', 'POST', '/api/leaves', 201, leave(4, 'submitted'), { from: '2026-11-03', days: 1, reason: 'PRM-20261031-1700-abcd-x' }),
  ob('manager', 'GET', '/api/approvals', 200, [leave(4, 'submitted')]),
  ob('manager', 'POST', '/api/leaves/4/approve', 200, leave(4, 'approved')),
  ob('employee', 'POST', '/api/leaves/4/cancel', 200, leave(4, 'cancelled')),
  ob('employee', 'POST', '/api/leaves/1/approve', 403, { error: 'no' }),
  ob('admin', 'GET', '/api/employees', 200, [{ id: 1, name: 'A', email: 'a@b.in', role: 'employee' }]),
];

describe('observed OpenAPI model', () => {
  it('groups by method + template and keeps status codes per role', () => {
    const m = buildApiModel(traffic());
    expect(m.operations.map((o) => o.key)).toEqual([
      'GET /api/approvals', 'GET /api/employees', 'GET /api/leaves', 'POST /api/leaves', 'POST /api/leaves/{id}/approve', 'POST /api/leaves/{id}/cancel',
    ]);
    const approve = m.operations.find((o) => o.key === 'POST /api/leaves/{id}/approve');
    expect(approve?.statusByRole).toEqual({ employee: [403], manager: [200] });
    expect(approve?.params).toEqual(['id']);
  });
  it('emits OpenAPI 3.1 with x-pramaan extensions and no sample values', () => {
    const doc = toOpenApi(buildApiModel(traffic()), { title: 'Demo', serverUrl: 'http://h' });
    const text = JSON.stringify(doc);
    expect(doc['openapi']).toBe('3.1.0');
    expect(text).toContain('"rolesSeen":["employee","manager"]');
    expect(text, 'no request values may leak into the spec').not.toContain('PRM-20261031');
  });
});

describe('entities', () => {
  it('finds the path root after the api prefix', () => {
    expect(pathRoot('/api/leaves/{id}/approve')).toBe('/api/leaves');
    expect(pathRoot('/v1/users', '/v1')).toBe('/v1/users');
  });
  it('merges a list endpoint whose records match another entity (approvals → leave)', () => {
    const ents = inferEntities(buildApiModel(traffic()));
    expect(ents.map((e) => e.name)).toEqual(['employee', 'leave']);
    const l = ents.find((e) => e.name === 'leave');
    expect(l?.operations).toContain('GET /api/approvals');
    expect(l?.createOp).toBe('POST /api/leaves');
    expect(l?.idField).toBe('id');
  });
  it('jaccard', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('state machines', () => {
  it('derives observed transitions from value-before → op → value-after', () => {
    const m = buildApiModel(traffic());
    const l = inferEntities(m).find((e) => e.name === 'leave');
    const sm = l && inferStateMachine(l, m);
    expect(sm?.field).toBe('status');
    expect(sm?.initial).toEqual(['submitted']);
    expect(sm?.transitions.map((x) => `${x.from}>${x.to}:${x.observed}`)).toEqual(['approved>cancelled:true', 'submitted>approved:true']);
  });
  it('adds UI hypotheses as observed:false and drops ops the probe found missing', () => {
    const m = buildApiModel(traffic());
    const l = inferEntities(m).find((e) => e.name === 'leave');
    if (!l) throw new Error('no leave entity');
    const hints = [{ role: 'manager', route: '/leaves/{id}', status: 'submitted', actions: ['Reject', 'Approve', 'Cancel leave'], ref: 'r' }];
    const sm = inferStateMachine(l, m, hints);
    const reject = sm?.transitions.find((x) => x.op === 'POST /api/leaves/{id}/reject');
    expect(reject).toMatchObject({ from: 'submitted', to: '?', observed: false, actors: ['manager'] });
    expect(sm?.transitions.find((x) => x.from === 'submitted' && x.op.endsWith('/cancel'))).toMatchObject({ to: 'cancelled', observed: false });
    const without = inferStateMachine(l, m, hints, new Set(['POST /api/leaves/{id}/reject']));
    expect(without?.transitions.some((x) => x.op.endsWith('/reject'))).toBe(false);
  });
  it('reads UI hints only from states showing exactly one status value', () => {
    const states = [
      { role: 'm', route: '/leaves/{id}', aria: '- definition "submitted"\n- button "Approve"', actions: ['Approve'], ref: 'a' },
      { role: 'm', route: '/leaves', aria: '- cell "submitted"\n- cell "approved"', actions: ['Cancel'], ref: 'b' },
    ];
    expect(uiHintsFrom(states, new Set(['submitted', 'approved'])).map((h) => h.ref)).toEqual(['a']);
  });
  it('verbOf takes the first word', () => {
    expect(verbOf('Cancel leave')).toBe('cancel');
  });
});

describe('lifecycle probe helpers', () => {
  it('retags free text from an earlier run', () => {
    expect(retag({ reason: 'PRM-20261027-2025-3422-dolor', days: 1 }, 'PRM', 'PRM-20261031-1700-abcd')).toEqual({ reason: 'PRM-20261031-1700-abcd-dolor', days: 1 });
  });
  it('finds the shortest path of observed transitions', () => {
    const sm = {
      field: 'status', states: [], initial: [],
      transitions: [
        { from: 'draft', op: 'submit', to: 'submitted', observed: true, actors: [], evidenceRefs: [] },
        { from: 'submitted', op: 'approve', to: 'approved', observed: true, actors: [], evidenceRefs: [] },
        { from: 'submitted', op: 'x', to: 'approved', observed: false, actors: [], evidenceRefs: [] },
      ],
    };
    expect(pathTo(sm, ['draft'], 'approved')?.map((x) => x.op)).toEqual(['submit', 'approve']);
    expect(pathTo(sm, ['submitted'], 'submitted')).toEqual([]);
    expect(pathTo(sm, ['approved'], 'draft')).toBeUndefined();
  });
});

describe('docs scoring', () => {
  it('finds the Flasgger spec url, defaulting to /apispec_1.json', () => {
    expect(specUrlFromDocsPage('url: "/apispec_2.json",', 'http://h:5002/apidocs/')).toBe('http://h:5002/apispec_2.json');
    expect(specUrlFromDocsPage('<html></html>', 'http://h:5002/apidocs/')).toBe('http://h:5002/apispec_1.json');
  });
  it('normalizes Flask and OpenAPI params and scores precision/recall', () => {
    const docs = docOperations({ basePath: '/api', paths: { '/leaves/<int:id>': { get: {}, parameters: [] }, '/leaves': { get: {}, post: {} }, '/payroll': { post: {} } } });
    expect([...docs].sort()).toEqual(['GET /api/leaves', 'GET /api/leaves/{}', 'POST /api/leaves', 'POST /api/payroll']);
    const s = scoreAgainstDocs(['GET /api/leaves', 'GET /api/leaves/{id}', 'GET /api/secret'], docs);
    expect(s).toMatchObject({ matched: 2, observed: 3, documented: 4, undocumented: ['GET /api/secret'] });
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBe(0.5);
    expect(opKey('get', '/a/{x}/')).toBe('GET /a/{}');
  });
});

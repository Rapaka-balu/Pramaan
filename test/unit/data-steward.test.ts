import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/core/ledger.js';
import type { Http } from '../../src/core/net.js';
import { runFaker } from '../../src/crawler/form-fill.js';
import { buildBody, enInFactory, isRealPanType, PAN_FORMAT, verhoeffValid } from '../../src/data/factories/en_IN.js';
import { findTagged, noteCleanupAsk, resolveTeardown, terminalStates } from '../../src/data/orphans.js';
import { Steward } from '../../src/data/steward.js';
import type { Entity } from '../../src/spec/entities.js';

const leave = (extra: Partial<Entity> = {}): Entity => ({
  name: 'leave',
  root: '/api/leaves',
  operations: ['GET /api/leaves', 'POST /api/leaves', 'POST /api/leaves/{id}/approve', 'POST /api/leaves/{id}/cancel', 'POST /api/leaves/{id}/reject'],
  fields: [],
  idField: 'id',
  createOp: 'POST /api/leaves',
  stateMachine: {
    field: 'status',
    states: ['approved', 'cancelled', 'draft', 'rejected', 'submitted'],
    initial: ['draft', 'submitted'],
    transitions: [
      { from: 'submitted', op: 'POST /api/leaves/{id}/approve', to: 'approved', observed: true, actors: ['manager'], evidenceRefs: [] },
      { from: 'submitted', op: 'POST /api/leaves/{id}/reject', to: 'rejected', observed: true, actors: ['manager'], evidenceRefs: [] },
      { from: 'approved', op: 'POST /api/leaves/{id}/cancel', to: 'cancelled', observed: true, actors: ['employee'], evidenceRefs: [] },
    ],
  },
  ...extra,
});

describe('en_IN factory', () => {
  const f = enInFactory(runFaker('20261031-2100-abcd'));
  it('makes +91 mobiles', () => {
    for (let i = 0; i < 20; i++) expect(f.mobile()).toMatch(/^\+91 [6-9]\d{9}$/);
  });
  it('makes PANs that match the format but use a holder type never issued', () => {
    for (let i = 0; i < 50; i++) {
      const pan = f.pan();
      expect(pan).toMatch(PAN_FORMAT);
      expect(isRealPanType(pan), pan).toBe(false);
    }
  });
  it('makes 12-digit Aadhaar numbers starting 2–9 that fail the Verhoeff check', () => {
    for (let i = 0; i < 50; i++) {
      const a = f.aadhaar();
      expect(a).toMatch(/^[2-9]\d{11}$/);
      expect(verhoeffValid(a)).toBe(false);
    }
  });
  it('verhoeff: a known-valid number passes, a changed digit fails', () => {
    expect(verhoeffValid('2363')).toBe(true); // 236 + check digit 3
    expect(verhoeffValid('2364')).toBe(false);
  });
  it('tags free text, moves dates into an IST window, refreshes personal fields, keeps the rest', () => {
    const body = buildBody(
      { properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } },
      { from: '2026-01-01', to: '2026-01-02', days: 1, reason: 'PRM-20261027-2025-3422-old', mobile: '9000000000', halfDay: false },
      { factory: f, runTag: 'PRM-20261031-2100-abcd', tagPrefix: 'PRM', dateOffset: 10, now: new Date('2026-10-31T10:00:00Z') },
    );
    expect(body).toMatchObject({ from: '2026-11-10', to: '2026-11-10', days: 1, halfDay: false });
    expect(String(body['reason'])).toMatch(/^PRM-20261031-2100-abcd-/);
    expect(String(body['mobile'])).toMatch(/^\+91 /);
  });
});

describe('teardown resolution', () => {
  it('prefers DELETE, then cancel, then reject (by the role that may reject)', () => {
    expect(resolveTeardown(leave({ operations: [...leave().operations, 'DELETE /api/leaves/{id}'] }))).toEqual({ op: 'DELETE /api/leaves/{id}' });
    expect(resolveTeardown(leave())).toEqual({ op: 'POST /api/leaves/{id}/cancel', endsIn: 'cancelled' });
    const noCancel = leave();
    noCancel.stateMachine = { ...leave().stateMachine!, transitions: leave().stateMachine!.transitions.filter((t) => !t.op.endsWith('/cancel')) };
    expect(resolveTeardown(noCancel)).toEqual({ op: 'POST /api/leaves/{id}/reject', actor: 'manager', endsIn: 'rejected' });
    expect(resolveTeardown(leave({ stateMachine: undefined }), 'POST /api/x/{id}/close')).toEqual({ op: 'POST /api/x/{id}/close' });
    expect(resolveTeardown(leave({ stateMachine: undefined }))).toBeUndefined();
  });
  it('terminal states have no observed way out', () => {
    expect([...terminalStates(leave())].sort()).toEqual(['cancelled', 'rejected']);
  });
  it('the steward calls a plan with an actor override as that actor', async () => {
    const calls: string[] = [];
    const http: Http = { calls: 0, request: async (url, init) => { calls.push(`${String((init?.headers as Record<string, string>)['x-role'])} ${new URL(url).pathname}`); return new Response(null, { status: 200 }); } };
    const s = new Steward(new Ledger({ root: mkdtempSync(join(tmpdir(), 'pramaan-m7-')), app: 'demo' }), 'r1');
    s.recordCreated({ entity: 'leave', id: '9', operation: 'POST /api/leaves', role: 'employee' });
    await s.teardown({ http, baseUrl: 'http://h', headersFor: (role) => ({ 'x-role': role }), plans: new Map([['leave', { op: 'POST /api/leaves/{id}/reject', actor: 'manager' }]]) });
    expect(calls).toEqual(['manager /api/leaves/9/reject']);
  });
});

describe('findTagged', () => {
  const lists: Record<string, unknown[]> = {
    employee: [
      { id: 1, reason: 'Family function', status: 'submitted' },
      { id: 4, reason: 'PRM-20261031-2100-abcd-x', status: 'submitted' },
      { id: 5, reason: 'PRM-20261031-2100-abcd-y', status: 'cancelled' },
      { id: 6, reason: 'PRM-20261030-0900-0000-z', status: 'approved' },
    ],
    manager: [{ id: 4, reason: 'PRM-20261031-2100-abcd-x', status: 'submitted' }],
  };
  const http: Http = {
    calls: 0,
    request: async (_url, init) => {
      const role = (init?.headers as Record<string, string>)['x-role'] ?? '';
      return new Response(JSON.stringify(lists[role] ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  const base = { http, apiOrigin: 'http://h', headersFor: (role: string) => ({ 'x-role': role }), roles: ['employee', 'manager'], entities: [leave()], tagPrefix: 'PRM' };
  it('finds live tagged records across roles, de-duplicated; terminal ones are retired', async () => {
    const r = await findTagged(base);
    expect(r.live.map((x) => `${x.id}:${x.status}`)).toEqual(['4:submitted', '6:approved']);
    expect(r.retired.map((x) => x.id)).toEqual(['5']);
  });
  it('can narrow to one run', async () => {
    const r = await findTagged({ ...base, runTag: 'PRM-20261030-0900-0000' });
    expect(r.live.map((x) => x.id)).toEqual(['6']);
  });
});

describe('noteCleanupAsk', () => {
  it('adds one ask per app + entity under its own heading', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'pramaan-needs-')), 'NEEDS-BALU.md');
    writeFileSync(f, '# Needs Balu\n\n## M2\n- [ ] something\n');
    expect(noteCleanupAsk(f, 'hrms', 'payslip')).toBe(true);
    expect(noteCleanupAsk(f, 'hrms', 'payslip')).toBe(false);
    expect(readFileSync(f, 'utf8')).toMatch(/## Cleanup endpoints \(M7 orphan policy\)\n- \[ \] \*\*hrms: no cleanup operation for `payslip`/);
  });
});

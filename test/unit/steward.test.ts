import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/core/ledger.js';
import type { Http } from '../../src/core/net.js';
import { entityFromPath, parseCreatedId, Steward, teardownOpFrom } from '../../src/data/steward.js';

const ledger = (): Ledger => new Ledger({ root: mkdtempSync(join(tmpdir(), 'pramaan-steward-')), app: 'demo' });

function fakeHttp(statusFor: (method: string, url: string) => number): Http & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    calls: 0,
    async request(url: string, init?: RequestInit): Promise<Response> {
      const method = init?.method ?? 'GET';
      log.push(`${method} ${new URL(url).pathname}`);
      return new Response(null, { status: statusFor(method, url) });
    },
  };
}

describe('entityFromPath', () => {
  it('singularizes the last non-param segment', () => {
    expect(entityFromPath('/api/leaves')).toBe('leave');
    expect(entityFromPath('/api/leave-categories')).toBe('leave-category');
    expect(entityFromPath('/api/employees/{id}/addresses')).toBe('address');
    expect(entityFromPath('/api/status')).toBe('status');
    expect(entityFromPath('/api/attendance')).toBe('attendance');
  });
});

describe('parseCreatedId', () => {
  it('reads id, <entity>_id, <entity>Id, data.id, then Location', () => {
    expect(parseCreatedId({ id: 7 }, undefined, 'leave')).toBe('7');
    expect(parseCreatedId({ leave_id: 'L9' }, undefined, 'leave')).toBe('L9');
    expect(parseCreatedId({ leaveRequestId: 3 }, undefined, 'leave-request')).toBe('3');
    expect(parseCreatedId({ data: { id: 5 } }, undefined, 'leave')).toBe('5');
    expect(parseCreatedId(null, '/api/leaves/12?x=1', 'leave')).toBe('12');
    expect(parseCreatedId({ ok: true }, undefined, 'leave')).toBeUndefined();
  });
});

describe('teardownOpFrom', () => {
  it('accepts DELETE on an id and POST …/{id}/cancel-like paths', () => {
    expect(teardownOpFrom('DELETE', '/api/leaves/{id}')).toBe('DELETE /api/leaves/{id}');
    expect(teardownOpFrom('post', '/api/leaves/{id}/cancel')).toBe('POST /api/leaves/{id}/cancel');
    expect(teardownOpFrom('POST', '/api/leaves/{id}/approve')).toBeUndefined();
    expect(teardownOpFrom('DELETE', '/api/leaves')).toBeUndefined();
  });
});

describe('Steward', () => {
  const rec = (id: string, extra: Partial<{ teardownOp: string; role: string }> = {}) => ({
    entity: 'leave',
    id,
    operation: 'POST /api/leaves',
    role: extra.role ?? 'employee',
    ...(extra.teardownOp ? { teardownOp: extra.teardownOp } : {}),
  });

  it('records data.created and exposes owned ids', () => {
    const l = ledger();
    const s = new Steward(l, 'run1');
    s.recordCreated(rec('4'));
    expect(s.ownedIds()).toEqual(new Set(['4']));
    expect(l.query({ type: 'data.created' })[0]?.data).toMatchObject({ entity: 'leave', id: '4', role: 'employee' });
  });

  it('tears down newest first with the learned op and classifies outcomes', async () => {
    const l = ledger();
    const s = new Steward(l, 'run1');
    s.recordCreated(rec('4'));
    s.recordCreated(rec('5'));
    s.recordCreated(rec('6', { role: 'ghost' }));
    const http = fakeHttp((_m, url) => (url.endsWith('/4/cancel') ? 409 : 200));
    const res = await s.teardown({
      http,
      baseUrl: 'http://h',
      headersFor: (role) => (role === 'employee' ? { authorization: 'Bearer x' } : undefined),
      learned: new Map([['leave', 'POST /api/leaves/{id}/cancel']]),
    });
    expect(http.log).toEqual(['POST /api/leaves/5/cancel', 'POST /api/leaves/4/cancel']);
    expect(res.deleted.map((r) => r.id)).toEqual(['5']);
    expect(res.retired.map((r) => r.id)).toEqual(['4']);
    expect(res.orphaned.map((o) => o.record.id)).toEqual(['6']);
    expect(Steward.orphans(l.read(), 'run1')).toEqual([]);
  });

  it('orphans records with no known teardown op or a failing one', async () => {
    const l = ledger();
    const s = new Steward(l, 'run1');
    s.recordCreated(rec('1'));
    s.recordCreated(rec('2', { teardownOp: 'DELETE /api/leaves/{id}' }));
    const res = await s.teardown({ http: fakeHttp(() => 500), baseUrl: 'http://h', headersFor: () => ({}) });
    expect(res.orphaned.map((o) => o.reason)).toEqual(['DELETE /api/leaves/{id} returned HTTP 500', 'no teardown operation known for leave']);
  });

  it('lists records not yet torn down from the ledger alone', () => {
    const l = ledger();
    new Steward(l, 'run1').recordCreated(rec('9'));
    new Steward(l, 'run2').recordCreated(rec('10'));
    expect(Steward.orphans(l.read(), 'run1').map((r) => r.id)).toEqual(['9']);
  });
});

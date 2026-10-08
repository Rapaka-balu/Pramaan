import { describe, expect, it } from 'vitest';
import { decideOwnership, isIdLikeSegment, type OwnershipRequest } from '../../src/core/ownership-guard.js';

const B = 'http://localhost:4600';
const owned = new Set(['101', '0f8fa2a4-5b0e-4c1e-9a3e-1d2b3c4d5e6f']);
const req = (r: Partial<OwnershipRequest> & { method: string; url: string }): OwnershipRequest => ({
  isLoginCall: false,
  createAllowed: true,
  ownedIds: owned,
  ...r,
});

describe('isIdLikeSegment', () => {
  it.each(['42', '0f8fa2a4-5b0e-4c1e-9a3e-1d2b3c4d5e6f', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '507f1f77bcf86cd799439011'])(
    'accepts %s',
    (s) => expect(isIdLikeSegment(s)).toBe(true),
  );
  it.each(['api', 'leaves', 'v1', 'approve', 'leave-balance'])('rejects %s', (s) => expect(isIdLikeSegment(s)).toBe(false));
});

describe('decideOwnership', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('allows %s on any id', (method) => {
    expect(decideOwnership(req({ method, url: `${B}/api/leaves/999` })).allow).toBe(true);
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'POST'])('aborts %s on a non-owned id', (method) => {
    const d = decideOwnership(req({ method, url: `${B}/api/leaves/999` }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/999/);
  });

  it('aborts POST /x/{id}/approve on a non-owned id', () => {
    expect(decideOwnership(req({ method: 'POST', url: `${B}/api/leaves/999/approve` })).allow).toBe(false);
  });

  it('allows create POST without id segment (foreign keys in body are fine)', () => {
    const d = decideOwnership(req({ method: 'POST', url: `${B}/api/leaves`, body: '{"leaveTypeId":3,"days":2}' }));
    expect(d).toEqual({ allow: true, reason: 'create (POST without id)' });
  });

  it('blocks create POST when createAllowed=false', () => {
    expect(decideOwnership(req({ method: 'POST', url: `${B}/api/leaves`, createAllowed: false })).allow).toBe(false);
  });

  it.each([
    ['PUT', '/api/leaves/101'],
    ['DELETE', '/api/leaves/101'],
    ['POST', '/api/leaves/101/approve'],
    ['PATCH', '/api/leaves/0f8fa2a4-5b0e-4c1e-9a3e-1d2b3c4d5e6f'],
  ])('allows owned-id %s %s', (method, path) => {
    expect(decideOwnership(req({ method, url: `${B}${path}` })).allow).toBe(true);
  });

  it('allows a body-targeted owned id', () => {
    expect(decideOwnership(req({ method: 'POST', url: `${B}/api/leaves/approve`, body: '{"leaveId":101}', createAllowed: false })).allow).toBe(true);
    expect(decideOwnership(req({ method: 'PUT', url: `${B}/api/leave`, body: '{"id":"101","days":3}' })).allow).toBe(true);
    expect(decideOwnership(req({ method: 'POST', url: `${B}/api/x`, body: 'leave_id=101&a=b', createAllowed: false })).allow).toBe(true);
  });

  it('blocks a body-targeted non-owned top-level id even if creates are allowed', () => {
    const d = decideOwnership(req({ method: 'POST', url: `${B}/api/leave/update`, body: '{"id":999}' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/999/);
  });

  it('blocks PUT without any owned target', () => {
    expect(decideOwnership(req({ method: 'PUT', url: `${B}/api/profile`, body: '{"name":"x"}' })).allow).toBe(false);
  });

  it('allows the login call', () => {
    expect(decideOwnership(req({ method: 'POST', url: `${B}/api/login`, isLoginCall: true, createAllowed: false })).allow).toBe(true);
  });

  it('blocks malformed URLs', () => {
    expect(decideOwnership(req({ method: 'POST', url: 'nope' })).allow).toBe(false);
  });
});

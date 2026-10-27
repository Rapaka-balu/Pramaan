import { describe, expect, it } from 'vitest';
import { classifyAction, patternMatches } from '../../src/crawler/safety.js';

const safety = {
  denyActionPatterns: ['delete', 'remove', 'cancel', 'approve', 'reject', 'edit', 'update', 'lock', 'run payroll', 'logout', 'sign out'],
  requiresApprovalPatterns: ['punch in', 'punch out', 'regulariz', 'payroll'],
  approvedActions: [] as string[],
};
const TAG = 'PRM-20261027-2010-ab12';

describe('patternMatches', () => {
  it('matches on a word start, case-insensitively', () => {
    expect(patternMatches('approve', 'Approve')).toBe(true);
    expect(patternMatches('approve', 'detail-approve-btn')).toBe(true);
    expect(patternMatches('approve', 'detailApproveBtn')).toBe(true);
  });
  it('lets spaces match - and _', () => {
    expect(patternMatches('punch in', 'punch-in-btn')).toBe(true);
    expect(patternMatches('punch in', 'Punch  in')).toBe(true);
    expect(patternMatches('sign out', 'sign_out')).toBe(true);
  });
  it('matches prefixes', () => {
    expect(patternMatches('regulariz', 'Regularize attendance')).toBe(true);
  });
  it('does not match inside a word', () => {
    expect(patternMatches('lock', 'Block user')).toBe(false);
    expect(patternMatches('edit', 'Credit note')).toBe(false);
  });
  it('is false for empty text or pattern', () => {
    expect(patternMatches('x', undefined)).toBe(false);
    expect(patternMatches('  ', 'anything')).toBe(false);
  });
});

describe('classifyAction', () => {
  it('allows ordinary actions', () => {
    expect(classifyAction({ name: 'Apply leave', testid: 'apply-leave-btn' }, safety, TAG)).toEqual({ kind: 'allow' });
  });
  it('denies a deny-pattern action on a record we do not own', () => {
    expect(classifyAction({ name: 'Cancel', containerText: 'Family function in Mysuru' }, safety, TAG)).toEqual({ kind: 'deny', pattern: 'cancel' });
  });
  it('lifts cancel/approve/reject/edit/update/delete for a row showing this run tag', () => {
    for (const name of ['Cancel', 'Approve', 'Reject', 'Edit', 'Update', 'Delete']) {
      expect(classifyAction({ name, containerText: `2026-11-03 ${TAG}-foo` }, safety, TAG).kind, name).toBe('owned');
    }
  });
  it('never lifts other deny patterns, even in an owned row', () => {
    expect(classifyAction({ name: 'Remove', containerText: TAG }, safety, TAG).kind).toBe('deny');
    expect(classifyAction({ name: 'Logout', containerText: TAG }, safety, TAG).kind).toBe('deny');
  });
  it('does not treat another run tag as owned', () => {
    expect(classifyAction({ name: 'Cancel', containerText: 'PRM-20261001-0900-0000-x' }, safety, TAG).kind).toBe('deny');
  });
  it('matches the testid, dialog title and form action, not only the name', () => {
    expect(classifyAction({ name: 'OK', testid: 'delete-confirm' }, safety, TAG).kind).toBe('deny');
    expect(classifyAction({ name: 'OK', dialogTitle: 'Delete employee?' }, safety, TAG).kind).toBe('deny');
    expect(classifyAction({ name: 'Save', formAction: '/employees/7/update' }, safety, TAG).kind).toBe('deny');
  });
  it('holds approval-gated actions until approved', () => {
    expect(classifyAction({ name: 'Punch in' }, safety, TAG)).toEqual({ kind: 'needs-approval', pattern: 'punch in' });
    expect(classifyAction({ name: 'Punch in' }, { ...safety, approvedActions: ['punch in'] }, TAG)).toEqual({ kind: 'allow' });
  });
  it('lets deny win over approval when both match', () => {
    expect(classifyAction({ name: 'Run payroll' }, safety, TAG).kind).toBe('deny');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompileError, emitAssertion, valueExpr } from '../../src/codegen/dsl-to-ts.js';
import { camel, methodName, pageClassName, slug, TEST_NAME_RE, testName, uniqueNames } from '../../src/codegen/names.js';
import { validateAssertion } from '../../src/dsl/validate.js';

describe('testName', () => {
  it.each([
    ['An employee cannot approve their own leave request', 'should_block_approve_their_own_leave_request_when_an_employee_tries'],
    ['Approving a submitted leave deducts exactly the requested days from the balance', 'should_deduct_exactly_the_requested_days_from_the_balance_when_approving_a_submitted_leave'],
    ['Cancelling an approved leave refunds the deducted days to the balance', 'should_refund_the_deducted_days_to_the_balance_when_cancelling_an_approved_leave'],
    ['A leave whose end date is before its start date is rejected', 'should_be_rejected_when_a_leave_whose_end_date_is_before_its_start_date'],
    ['A leave must request more than 0 days', 'should_request_more_than_0_days_when_a_leave'],
    ['A half-day leave counts as 0.5 days against the balance', 'should_count_as_0_5_days_against_the_balance_when_a_half_day_leave'],
    ['A leave status only moves along its state machine (no approving twice)', 'should_only_moves_along_its_state_machine_no_approving_twice_when_a_leave_status'],
    ['Leaves exist', 'should_hold_when_leaves_exist'],
  ])('%s', (title, name) => {
    expect(testName(title)).toBe(name);
    expect(name).toMatch(TEST_NAME_RE);
  });
  it('always matches the lint regex', () => {
    for (const t of ['₹ amounts render with grouping', '!!!', 'When X then Y', 'Dates render as DD/MM/YYYY in the user interface']) expect(testName(t)).toMatch(TEST_NAME_RE);
  });
});

describe('identifiers', () => {
  it('slug, camel, unique names', () => {
    expect(slug("Employee's half-day (0.5)")).toBe('employee_s_half_day_0_5');
    expect(camel('balBefore')).toBe('balBefore');
    expect(camel('leave_id')).toBe('leaveId');
    expect(uniqueNames(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a_2', 'a_3']);
  });
  it('page and method names', () => {
    expect(pageClassName('/leaves/{id}')).toBe('LeavesByIdPage');
    expect(pageClassName('/')).toBe('HomePage');
    expect(pageClassName('/leaves?scope')).toBe('LeavesScopePage');
    expect(methodName('click', 'Apply leave')).toBe('clickApplyLeave');
    expect(methodName('fill', 'Reason')).toBe('fillReason');
  });
});

describe('DSL → TypeScript', () => {
  const ops = new Set(['GET /api/leave-balance', 'POST /api/leaves', 'POST /api/leaves/{id}/approve', 'POST /api/leaves/{id}/cancel']);
  const a012 = validateAssertion(JSON.parse(readFileSync(join('test', 'fixtures', 'dsl', 'A-012.json'), 'utf8')), ops);
  if (!a012.ok) throw new Error('fixture');

  it('emits §10.2-shaped code: sections, steward.create for creates, messages on every expect', () => {
    const t = emitAssertion(a012.assertion, new Map([['POST /api/leaves', 'leave']]));
    const code = t.body.join('\n');
    expect(code).toContain('// Arrange\nconst days = 2;');
    expect(code).toContain("const apply = await steward.create('leave', { actor: 'employee', body: { from: dates.todayPlus(7), to: dates.todayPlus(8), days: days, reason: `${runTag} R-012` } });");
    expect(code).toContain('const capLeaveId = jp(apply.body, "$.id");');
    expect(code).toContain("const approve = await call(await api.as('admin'), 'POST', `/api/leaves/${encodeURIComponent(String(capLeaveId))}/approve`);");
    expect(code).toContain('expect(approve.status, "admin should be able to approve a submitted leave").toBe(200);');
    expect(code).toContain('expect(Number(jp(balAfter.body, "$.available")) - Number(jp(balBefore.body, "$.available")), "available balance should drop by the approved days").toBeCloseTo(-2, 6);');
    expect(code).not.toContain('cancel');
    expect(t.actors).toEqual(['employee', 'admin']);
    expect(code.match(/expect\(/g)?.length).toBe(code.match(/expect\([^;]*, "/g)?.length);
  });
  it('renders values: lone refs keep type, mixed text becomes a template literal', () => {
    const ctx = { data: new Map([['days', 'days']]), caps: new Set(['x']), createOps: new Map() };
    expect(valueExpr('${data.days}', ctx)).toBe('days');
    expect(valueExpr('${run.tag}-${cap.x}`', ctx)).toBe('`${runTag}-${capX}\\``');
    expect(valueExpr({ 'a-b': [1, true, null] }, ctx)).toBe('{ "a-b": [1, true, null] }');
    expect(() => valueExpr('${cap.y}', ctx)).toThrow(CompileError);
  });
  it('uses toContain for several allowed statuses', () => {
    const a = structuredClone(a012.assertion);
    a.assert = [{ kind: 'status', step: 'approve', oneOf: [403, 404], message: 'should be refused politely' }];
    expect(emitAssertion(a, new Map()).body.join('\n')).toContain('expect([403, 404], "should be refused politely").toContain(approve.status);');
  });
  it('refuses delta expressions that depend on a capture', () => {
    const a = structuredClone(a012.assertion);
    a.assert = [{ kind: 'delta', before: 'balBefore', after: 'balAfter', path: '$.available', expected: '-${cap.leaveId}', message: 'nonsense but valid' }];
    expect(() => emitAssertion(a, new Map())).toThrow(CompileError);
  });
});

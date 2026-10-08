import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { startDemo, type DemoServer } from '../../fixtures/demo-hrms/server.mjs';
import { BugCatalog } from '../../src/core/schemas.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PASSWORD = 'Demo@123';

interface Session {
  token: string;
  tenant: string;
  userId: number;
}

interface ApiResult {
  status: number;
  body: unknown;
}

const servers: DemoServer[] = [];

async function boot(env: Record<string, string> = {}): Promise<DemoServer> {
  const demo = await startDemo({ port: 0, env: { DEMO_BUGS: 'none', ...env } });
  servers.push(demo);
  return demo;
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

async function call(
  demo: DemoServer,
  method: string,
  url: string,
  opts: { session?: Session; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.session) {
    headers['Authorization'] = `Bearer ${opts.session.token}`;
    headers['X-Tenant-Code'] ??= opts.session.tenant;
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`${demo.url}${url}`, init);
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') && text ? (JSON.parse(text) as unknown) : text };
}

async function login(demo: DemoServer, email: string, tenant = 'TEST'): Promise<Session> {
  const res = await call(demo, 'POST', '/api/auth/login', { body: { tenant, email, password: PASSWORD } });
  expect(res.status, `login for ${email} should succeed`).toBe(200);
  const user = field(res.body, 'user');
  return { token: String(field(res.body, 'token')), tenant, userId: Number(field(user, 'id')) };
}

async function applyLeave(demo: DemoServer, session: Session, body: Record<string, unknown>): Promise<ApiResult> {
  return call(demo, 'POST', '/api/leaves', {
    session,
    body: { from: '2026-12-01', to: '2026-12-02', days: 2, reason: 'PRM-test-leave', ...body },
  });
}

async function createLeaveId(demo: DemoServer, session: Session, body: Record<string, unknown> = {}): Promise<number> {
  const res = await applyLeave(demo, session, body);
  expect(res.status, 'leave creation should return 201').toBe(201);
  return Number(field(res.body, 'id'));
}

async function available(demo: DemoServer, session: Session): Promise<number> {
  const res = await call(demo, 'GET', '/api/leave-balance', { session });
  expect(res.status, 'balance read should succeed').toBe(200);
  return Number(field(res.body, 'available'));
}

/** Two instances: correct and with a given bug. Each test resets them first. */
async function pair(bug: string): Promise<{ good: DemoServer; bad: DemoServer }> {
  const [good, bad] = await Promise.all([boot(), boot({ DEMO_BUGS: bug })]);
  return { good, bad };
}

describe('demo HRMS: auth', () => {
  let demo: DemoServer;
  beforeAll(async () => {
    demo = await boot();
  });

  it('should_return_token_when_credentials_are_valid', async () => {
    const res = await call(demo, 'POST', '/api/auth/login', {
      body: { tenant: 'TEST', email: 'emp1@demo.local', password: PASSWORD },
    });
    expect(res.status, 'valid login should be 200').toBe(200);
    expect(field(res.body, 'user'), 'login should return the user').toMatchObject({
      name: 'Asha Rao',
      role: 'employee',
      tenant: 'TEST',
    });
    expect(String(field(res.body, 'token')).split('.'), 'token should have payload and signature').toHaveLength(2);
  });

  it('should_return_401_when_password_or_tenant_is_wrong', async () => {
    const wrongPassword = await call(demo, 'POST', '/api/auth/login', {
      body: { tenant: 'TEST', email: 'emp1@demo.local', password: 'nope' },
    });
    expect(wrongPassword.status, 'wrong password should be 401').toBe(401);
    expect(field(wrongPassword.body, 'error'), 'error text should be generic').toBe('Invalid credentials');
    const wrongTenant = await call(demo, 'POST', '/api/auth/login', {
      body: { tenant: 'TEST2', email: 'emp1@demo.local', password: PASSWORD },
    });
    expect(wrongTenant.status, 'user from another tenant should be 401').toBe(401);
  });

  it('should_log_in_all_six_users', async () => {
    const users: [string, string][] = [
      ['emp1@demo.local', 'TEST'],
      ['emp2@demo.local', 'TEST'],
      ['mgr1@demo.local', 'TEST'],
      ['admin1@demo.local', 'TEST'],
      ['admin2@demo.local', 'TEST2'],
      ['emp3@demo.local', 'TEST2'],
    ];
    for (const [email, tenant] of users) {
      const s = await login(demo, email, tenant);
      const me = await call(demo, 'GET', '/api/me', { session: s });
      expect(field(me.body, 'email'), `/api/me should return ${email}`).toBe(email);
    }
  });

  it('should_return_401_when_token_is_missing_or_tampered', async () => {
    const missing = await call(demo, 'GET', '/api/leaves', { headers: { 'X-Tenant-Code': 'TEST' } });
    expect(missing.status, 'missing token should be 401').toBe(401);
    const s = await login(demo, 'emp1@demo.local');
    const tampered = await call(demo, 'GET', '/api/leaves', { session: { ...s, token: `${s.token}x` } });
    expect(tampered.status, 'tampered token should be 401').toBe(401);
  });

  it('should_return_403_when_tenant_header_does_not_match_token', async () => {
    const s = await login(demo, 'emp1@demo.local');
    const res = await call(demo, 'GET', '/api/leaves', { session: s, headers: { 'X-Tenant-Code': 'TEST2' } });
    expect(res.status, 'tenant header mismatch should be 403').toBe(403);
  });
});

describe('demo HRMS: leave state machine and balance (DEMO_BUGS=none)', () => {
  let demo: DemoServer;
  let emp1: Session;
  let mgr: Session;
  beforeAll(async () => {
    demo = await boot();
    emp1 = await login(demo, 'emp1@demo.local');
    mgr = await login(demo, 'mgr1@demo.local');
  });

  it('should_deduct_on_approve_and_refund_on_cancel', async () => {
    await call(demo, 'POST', '/__reset');
    expect(await available(demo, emp1), 'seed balance should be 20').toBe(20);
    const id = await createLeaveId(demo, emp1, { days: 2 });
    const approved = await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
    expect(field(approved.body, 'status'), 'approve should move to approved').toBe('approved');
    expect(await available(demo, emp1), 'approval should deduct 2 days').toBe(18);
    const again = await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
    expect(again.status, 'approving a non-submitted leave should be 409').toBe(409);
    const cancelled = await call(demo, 'POST', `/api/leaves/${id}/cancel`, { session: emp1 });
    expect(field(cancelled.body, 'status'), 'cancel should move to cancelled').toBe('cancelled');
    expect(await available(demo, emp1), 'cancel should refund 2 days').toBe(20);
  });

  it('should_deduct_half_a_day_for_half_day_leave', async () => {
    await call(demo, 'POST', '/__reset');
    const id = await createLeaveId(demo, emp1, { from: '2026-12-01', to: '2026-12-01', halfDay: true, days: undefined });
    await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
    expect(await available(demo, emp1), 'half day should deduct 0.5').toBe(19.5);
  });

  it('should_support_draft_submit_and_reject', async () => {
    await call(demo, 'POST', '/__reset');
    const id = await createLeaveId(demo, emp1, { draft: true });
    const early = await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
    expect(early.status, 'approving a draft should be 409').toBe(409);
    const submitted = await call(demo, 'POST', `/api/leaves/${id}/submit`, { session: emp1 });
    expect(field(submitted.body, 'status'), 'submit should move draft to submitted').toBe('submitted');
    const rejected = await call(demo, 'POST', `/api/leaves/${id}/reject`, { session: mgr });
    expect(field(rejected.body, 'status'), 'reject should move to rejected').toBe('rejected');
    const cancel = await call(demo, 'POST', `/api/leaves/${id}/cancel`, { session: emp1 });
    expect(cancel.status, 'cancelling a rejected leave should be 409').toBe(409);
  });

  it('should_forbid_employee_approvals_and_admin_endpoints', async () => {
    const approve = await call(demo, 'POST', '/api/leaves/1/approve', { session: emp1 });
    expect(approve.status, 'employee cannot approve').toBe(403);
    const approvals = await call(demo, 'GET', '/api/approvals', { session: emp1 });
    expect(approvals.status, 'employee cannot list approvals').toBe(403);
    const all = await call(demo, 'GET', '/api/leaves?all=1', { session: emp1 });
    expect(all.status, 'employee cannot list all leaves').toBe(403);
  });

  it('should_list_pending_approvals_excluding_own', async () => {
    await call(demo, 'POST', '/__reset');
    const res = await call(demo, 'GET', '/api/approvals', { session: mgr });
    const ids = (res.body as { id: number }[]).map((l) => l.id);
    expect(ids, 'manager should see the seeded submitted leave of emp1').toEqual([1]);
  });

  it('should_return_400_with_field_for_invalid_input', async () => {
    const res = await applyLeave(demo, emp1, { days: 1.3 });
    expect(res.status, 'non-half multiple should be 400').toBe(400);
    expect(field(res.body, 'field'), 'error should name the field').toBe('days');
  });

  it('should_punch_in_and_out', async () => {
    await call(demo, 'POST', '/__reset');
    expect((await call(demo, 'POST', '/api/attendance/punch-in', { session: emp1 })).status, 'punch in').toBe(201);
    expect((await call(demo, 'POST', '/api/attendance/punch-in', { session: emp1 })).status, 'double punch in').toBe(409);
    expect((await call(demo, 'POST', '/api/attendance/punch-out', { session: emp1 })).status, 'punch out').toBe(200);
    const list = await call(demo, 'GET', '/api/attendance', { session: emp1 });
    expect(list.body, 'attendance should have seed + new record').toHaveLength(2);
  });
});

describe('demo HRMS: seeded bugs change behaviour vs none', () => {
  it('should_toggle_idor_leave_read', async () => {
    const { good, bad } = await pair('idor-leave-read');
    for (const [demo, expected] of [
      [good, 404],
      [bad, 200],
    ] as const) {
      const emp1 = await login(demo, 'emp1@demo.local');
      const emp2 = await login(demo, 'emp2@demo.local');
      const id = await createLeaveId(demo, emp1);
      const res = await call(demo, 'GET', `/api/leaves/${id}`, { session: emp2 });
      expect(res.status, `emp2 reading emp1's leave should be ${expected}`).toBe(expected);
      if (expected === 200) expect(field(res.body, 'employeeId'), 'IDOR leaks emp1 leave').toBe(emp1.userId);
    }
  });

  it('should_toggle_employee_admin_endpoint', async () => {
    const { good, bad } = await pair('employee-admin-endpoint');
    const g = await call(good, 'GET', '/api/employees', { session: await login(good, 'emp1@demo.local') });
    const b = await call(bad, 'GET', '/api/employees', { session: await login(bad, 'emp1@demo.local') });
    expect(g.status, 'employee should be denied when correct').toBe(403);
    expect(b.status, 'employee should be allowed with bug').toBe(200);
  });

  it('should_toggle_cross_tenant_list', async () => {
    const { good, bad } = await pair('cross-tenant-list');
    const tenants = async (demo: DemoServer): Promise<string[]> => {
      const res = await call(demo, 'GET', '/api/leaves?all=1', { session: await login(demo, 'admin1@demo.local') });
      return [...new Set((res.body as { tenant: string }[]).map((l) => l.tenant))].sort();
    };
    expect(await tenants(good), 'admin should only see own tenant').toEqual(['TEST']);
    expect(await tenants(bad), 'bug leaks other tenant').toEqual(['TEST', 'TEST2']);
  });

  it('should_toggle_self_approve', async () => {
    const { good, bad } = await pair('self-approve');
    for (const [demo, expected] of [
      [good, 403],
      [bad, 200],
    ] as const) {
      const mgr = await login(demo, 'mgr1@demo.local');
      const id = await createLeaveId(demo, mgr);
      const res = await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
      expect(res.status, `self approval should be ${expected}`).toBe(expected);
    }
  });

  it('should_toggle_double_approve', async () => {
    const { good, bad } = await pair('double-approve');
    for (const [demo, status, balance] of [
      [good, 409, 18],
      [bad, 200, 16],
    ] as const) {
      const emp1 = await login(demo, 'emp1@demo.local');
      const mgr = await login(demo, 'mgr1@demo.local');
      const id = await createLeaveId(demo, emp1, { days: 2 });
      await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
      const again = await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
      expect(again.status, `second approve should be ${status}`).toBe(status);
      expect(await available(demo, emp1), `balance should be ${balance}`).toBe(balance);
    }
  });

  it('should_toggle_cancel_no_refund', async () => {
    const { good, bad } = await pair('cancel-no-refund');
    for (const [demo, balance] of [
      [good, 20],
      [bad, 18],
    ] as const) {
      const emp1 = await login(demo, 'emp1@demo.local');
      const mgr = await login(demo, 'mgr1@demo.local');
      const id = await createLeaveId(demo, emp1, { days: 2 });
      await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
      await call(demo, 'POST', `/api/leaves/${id}/cancel`, { session: emp1 });
      expect(await available(demo, emp1), `balance after cancel should be ${balance}`).toBe(balance);
    }
  });

  it('should_toggle_balance_off_by_one', async () => {
    const { good, bad } = await pair('balance-off-by-one');
    for (const [demo, balance] of [
      [good, 18],
      [bad, 17],
    ] as const) {
      const emp1 = await login(demo, 'emp1@demo.local');
      const mgr = await login(demo, 'mgr1@demo.local');
      const id = await createLeaveId(demo, emp1, { days: 2 });
      await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
      expect(await available(demo, emp1), `balance after approving 2 days should be ${balance}`).toBe(balance);
    }
  });

  it('should_toggle_half_day_rounding', async () => {
    const { good, bad } = await pair('half-day-rounding');
    for (const [demo, balance] of [
      [good, 19.5],
      [bad, 19],
    ] as const) {
      const emp1 = await login(demo, 'emp1@demo.local');
      const mgr = await login(demo, 'mgr1@demo.local');
      const id = await createLeaveId(demo, emp1, { from: '2026-12-01', to: '2026-12-01', days: 0.5, halfDay: true });
      await call(demo, 'POST', `/api/leaves/${id}/approve`, { session: mgr });
      expect(await available(demo, emp1), `balance after half day should be ${balance}`).toBe(balance);
    }
  });

  it('should_toggle_negative_days', async () => {
    const { good, bad } = await pair('negative-days');
    const g = await applyLeave(good, await login(good, 'emp1@demo.local'), { days: -2 });
    const b = await applyLeave(bad, await login(bad, 'emp1@demo.local'), { days: -2 });
    expect(g.status, 'negative days should be 400').toBe(400);
    expect(field(g.body, 'field'), 'error should name days').toBe('days');
    expect(b.status, 'bug accepts negative days').toBe(201);
  });

  it('should_toggle_end_before_start', async () => {
    const { good, bad } = await pair('end-before-start');
    const body = { from: '2026-12-05', to: '2026-12-01', days: 1 };
    const g = await applyLeave(good, await login(good, 'emp1@demo.local'), body);
    const b = await applyLeave(bad, await login(bad, 'emp1@demo.local'), body);
    expect(g.status, 'end before start should be 400').toBe(400);
    expect(field(g.body, 'field'), 'error should name to').toBe('to');
    expect(b.status, 'bug accepts end before start').toBe(201);
  });

  it('should_toggle_ist_midnight', async () => {
    const { good, bad } = await pair('ist-midnight');
    const body = { from: undefined, to: undefined, fromTime: '2026-12-10T00:30:00+05:30', days: 0.5, halfDay: true };
    const g = await applyLeave(good, await login(good, 'emp1@demo.local'), body);
    const b = await applyLeave(bad, await login(bad, 'emp1@demo.local'), body);
    expect(field(g.body, 'from'), 'from should be the IST date').toBe('2026-12-10');
    expect(field(b.body, 'from'), 'bug stores the UTC date').toBe('2026-12-09');
  });

  it('should_toggle_long_reason_500', async () => {
    const { good, bad } = await pair('long-reason-500');
    const body = { reason: `PRM-${'x'.repeat(250)}` };
    const g = await applyLeave(good, await login(good, 'emp1@demo.local'), body);
    const b = await applyLeave(bad, await login(bad, 'emp1@demo.local'), body);
    expect(g.status, 'long reason should be 400').toBe(400);
    expect(field(g.body, 'field'), 'error should name reason').toBe('reason');
    expect(b.status, 'bug returns 500').toBe(500);
  });

  it('should_toggle_csv_export_mismatch', async () => {
    const { good, bad } = await pair('csv-export-mismatch');
    for (const [demo, days] of [
      [good, '0.5'],
      [bad, '1'],
    ] as const) {
      const emp1 = await login(demo, 'emp1@demo.local');
      const id = await createLeaveId(demo, emp1, { from: '2026-12-01', to: '2026-12-01', days: 0.5, halfDay: true });
      const csv = await call(demo, 'GET', '/api/leaves/export.csv', { session: emp1 });
      const lines = String(csv.body).trim().split('\r\n');
      expect(lines[0], 'CSV header').toBe('id,from,to,days,status,reason');
      const row = lines.find((l) => l.startsWith(`${id},`));
      expect(row?.split(',')[3], `CSV days should be ${days}`).toBe(days);
    }
  });

  it('should_inject_ui_bug_flags_into_the_spa', async () => {
    const [good, bad] = await Promise.all([
      boot(),
      boot({ DEMO_BUGS: 'dashboard-console-error,stale-ui-balance' }),
    ]);
    const g = await (await fetch(`${good.url}/dashboard`)).text();
    const b = await (await fetch(`${bad.url}/dashboard`)).text();
    expect(g, 'correct app has both UI flags off').toContain('"cacheBalance":false,"announcementsWidget":false');
    expect(b, 'bugged app has both UI flags on').toContain('"cacheBalance":true,"announcementsWidget":true');
  });

  it('should_reject_unknown_bug_ids', async () => {
    await expect(startDemo({ port: 0, env: { DEMO_BUGS: 'no-such-bug' } }), 'typos should fail fast').rejects.toThrow(
      /Unknown DEMO_BUGS/,
    );
  });
});

describe('demo HRMS: toggles, reset and request log', () => {
  it('should_produce_same_503_sequence_for_same_seed', async () => {
    const sequence = async (seed: string): Promise<number[]> => {
      const demo = await boot({ DEMO_FLAKY: '0.3', DEMO_SEED: seed });
      const s = await login(demo, 'emp1@demo.local');
      const out: number[] = [];
      for (let i = 0; i < 20; i++) out.push((await call(demo, 'GET', '/api/leave-balance', { session: s })).status);
      return out;
    };
    const a = await sequence('42');
    const b = await sequence('42');
    const c = await sequence('7');
    expect(a, 'same seed gives the same sequence').toEqual(b);
    expect(a, 'flaky mode should produce some 503s').toContain(503);
    expect(a, 'flaky mode should produce some 200s').toContain(200);
    expect(a, 'different seed gives a different sequence').not.toEqual(c);
  });

  it('should_rename_balance_route_and_add_field_with_api_v2', async () => {
    const demo = await boot({ DEMO_API_V2: '1' });
    const s = await login(demo, 'emp1@demo.local');
    expect((await call(demo, 'GET', '/api/leave-balance', { session: s })).status, 'old route gone').toBe(404);
    expect((await call(demo, 'GET', '/api/leave-balances', { session: s })).status, 'new route works').toBe(200);
    const leaves = await call(demo, 'GET', '/api/leaves', { session: s });
    expect((leaves.body as Record<string, unknown>[])[0], 'leaves gain leaveType').toMatchObject({ leaveType: 'casual' });
    const html = await (await fetch(`${demo.url}/dashboard`)).text();
    expect(html, 'SPA should use the new route').toContain('"/api/leave-balances"');
  });

  it('should_restore_seed_on_reset', async () => {
    const demo = await boot();
    const emp1 = await login(demo, 'emp1@demo.local');
    await createLeaveId(demo, emp1);
    expect((await call(demo, 'GET', '/api/leaves', { session: emp1 })).body, 'two leaves before reset').toHaveLength(2);
    expect((await call(demo, 'POST', '/__reset')).status, 'reset from loopback').toBe(200);
    const after = (await call(demo, 'GET', '/api/leaves', { session: emp1 })).body as { id: number }[];
    expect(after.map((l) => l.id), 'only the seeded leave remains').toEqual([1]);
    const next = await createLeaveId(demo, emp1);
    expect(next, 'ids restart after reset').toBe(4);
  });

  it('should_record_api_calls_in_request_log', async () => {
    const demo = await boot();
    const emp1 = await login(demo, 'emp1@demo.local');
    await call(demo, 'GET', '/api/leaves/1?x=1', { session: emp1 });
    await call(demo, 'GET', '/api/leaves');
    const log = await call(demo, 'GET', '/__requests');
    expect(log.body, 'HTTP log equals in-process log').toEqual(demo.requestLog);
    expect(demo.requestLog.map((e) => [e.method, e.path, e.status, e.userId, e.tenant]), 'log entries').toEqual([
      ['POST', '/api/auth/login', 200, emp1.userId, 'TEST'],
      ['GET', '/api/leaves/1', 200, emp1.userId, 'TEST'],
      ['GET', '/api/leaves', 401, null, null],
    ]);
  });
});

describe('demo HRMS: SPA and catalog', () => {
  it('should_serve_spa_with_expected_testids', async () => {
    const demo = await boot();
    const res = await fetch(`${demo.url}/dashboard`);
    const html = await res.text();
    expect(res.status, 'SPA route should be 200').toBe(200);
    for (const id of [
      'login-tenant',
      'login-password',
      'login-submit',
      'login-error',
      'nav-dashboard',
      'logout-btn',
      'balance-days',
      'apply-leave-link',
      'apply-leave-btn',
      'export-csv-btn',
      'cancel-leave-btn',
      'approve-btn',
      'punch-in-btn',
    ]) {
      expect(html, `index.html should contain data-testid="${id}"`).toContain(`data-testid="${id}"`);
    }
    for (const label of ['Tenant code', 'Email', 'Password']) {
      expect(html, `login should have label ${label}`).toContain(`>${label}</label>`);
    }
    const unknown = await fetch(`${demo.url}/no-such-page`, { headers: { Accept: 'text/html' } });
    expect(unknown.status, 'unknown page should be 404 with the SPA shell').toBe(404);
  });

  it('should_rename_apply_testid_with_drift', async () => {
    const demo = await boot({ DEMO_DRIFT: 'apply-testid' });
    const html = await (await fetch(`${demo.url}/leaves/apply`)).text();
    expect(html, 'drifted testid present').toContain('data-testid="apply-leave-submit"');
    expect(html, 'original testid gone').not.toContain('data-testid="apply-leave-btn"');
  });

  it('should_parse_bug_catalog', () => {
    const raw: unknown = parse(readFileSync(path.join(ROOT, 'benchmark', 'demo', 'bugs.yaml'), 'utf8'));
    const catalog = BugCatalog.parse(raw);
    expect(catalog.bugs, 'all 15 bugs listed').toHaveLength(15);
    expect(catalog.bugs.filter((b) => !b.mvp).map((b) => b.id), 'only csv export is post-MVP').toEqual([
      'csv-export-mismatch',
    ]);
  });
});

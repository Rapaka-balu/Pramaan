import { describe, expect, it, vi } from 'vitest';
import { loadAppConfig, repoRoot } from '../../src/core/config.js';
import type { Http } from '../../src/core/net.js';
import { checkContract, checkRoles } from '../../src/onboarding/contract.js';
import { blockingFailures, renderCannotProceed, renderOnboardingMd, type OnboardRow } from '../../src/onboarding/report.js';

const root = repoRoot();
const hrmsEnv = {
  HRMS_TENANT_PRIMARY: 'TEST',
  HRMS_EMPLOYEE_EMAIL: 'e@x.in',
  HRMS_EMPLOYEE_PASSWORD: 'p',
  HRMS_ADMIN_EMAIL: 'a@x.in',
  HRMS_ADMIN_PASSWORD: 'p',
};
const stubHttp = (status = 200): Http & { request: ReturnType<typeof vi.fn> } => {
  const request = vi.fn(async () => new Response('', { status }));
  return { request, calls: 0 } as unknown as Http & { request: ReturnType<typeof vi.fn> };
};

describe('checkRoles', () => {
  it('should_mark_optional_roles_cannot_verify_when_their_env_is_missing', () => {
    const roles = checkRoles(loadAppConfig('hrms', { root, env: hrmsEnv }));
    expect(roles.find((r) => r.role === 'employee')?.status).toBe('ready');
    expect(roles.find((r) => r.role === 'employee2')?.status).toBe('cannot-verify');
    expect(roles.find((r) => r.role === 'other-employee')?.reason).toContain('HRMS_TENANT_SECONDARY');
  });

  it('should_mark_required_role_missing_when_password_env_is_empty', () => {
    const roles = checkRoles(loadAppConfig('hrms', { root, env: { ...hrmsEnv, HRMS_ADMIN_PASSWORD: '' } }));
    const admin = roles.find((r) => r.role === 'admin');
    expect(admin?.status).toBe('missing');
    expect(admin?.reason).toContain('HRMS_ADMIN_PASSWORD');
  });

  it('should_never_put_credential_values_in_reasons', () => {
    const roles = checkRoles(loadAppConfig('hrms', { root, env: { ...hrmsEnv, HRMS_ADMIN_EMAIL: '' } }));
    expect(JSON.stringify(roles)).not.toContain('e@x.in');
  });
});

describe('checkContract', () => {
  it('should_make_no_network_calls_when_hrms_has_no_target_flag', async () => {
    const http = stubHttp();
    const res = await checkContract(loadAppConfig('hrms', { root, env: hrmsEnv }), { http });
    expect(http.request).not.toHaveBeenCalled();
    expect(res.networkAllowed).toBe(false);
    expect(res.ok).toBe(false);
  });

  it('should_check_ui_and_api_origins_when_target_is_staging', async () => {
    const http = stubHttp(200);
    const res = await checkContract(loadAppConfig('hrms', { root, env: hrmsEnv }), { http, target: 'staging' });
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it('should_fail_when_ui_origin_answers_5xx', async () => {
    const res = await checkContract(loadAppConfig('hrms', { root, env: hrmsEnv }), {
      http: stubHttp(503),
      target: 'staging',
    });
    expect(res.ok).toBe(false);
    expect(res.origins[0]?.status).toBe('unreachable');
  });
});

describe('report', () => {
  const rows: OnboardRow[] = [
    { role: 'employee', tenant: 'primary', optional: false, status: 'ok', reason: '', ms: 1200 },
    { role: 'admin', tenant: 'primary', optional: false, status: 'failed', reason: 'Invalid credentials', ms: 900 },
    { role: 'employee2', tenant: 'primary', optional: true, status: 'skipped', reason: 'cannot verify', ms: 0 },
  ];

  it('should_render_one_row_per_role', () => {
    const md = renderOnboardingMd('demo', 'r1', rows, []);
    expect(md).toContain('| employee | primary | ok |');
    expect(md).toContain('| employee2 (optional) | primary | skipped | cannot verify |');
  });

  it('should_name_failed_required_role_and_error_text_in_cannot_proceed', () => {
    const failures = blockingFailures(rows);
    expect(failures.map((f) => f.role)).toEqual(['admin']);
    const md = renderCannotProceed('demo', failures, []);
    expect(md).toContain('`admin`');
    expect(md).toContain('Invalid credentials');
  });
});

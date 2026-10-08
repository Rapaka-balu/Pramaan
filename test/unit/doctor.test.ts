import { describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../../src/core/config.js';
import { runDoctor } from '../../src/cli/doctor.js';

const root = repoRoot();
const fakeBrowsers = (): Record<string, string> => ({ chromium: process.execPath });

describe('doctor', () => {
  it('should_make_zero_network_calls_when_hrms_runs_without_target_flag', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const report = await runDoctor({
      appId: 'hrms',
      root,
      env: { PRAMAAN_LLM_MODE: 'replay-or-off' },
      fetchImpl,
      browserPaths: fakeBrowsers,
    });
    expect(fetchImpl, 'doctor must not touch the network for hrms without --target').not.toHaveBeenCalled();
    expect(report.networkCalls).toBe(0);
    expect(report.checks.find((c) => c.name === 'reachability')?.status).toBe('skip');
  });

  it('should_list_exact_missing_env_keys_when_hrms_env_is_empty', async () => {
    const report = await runDoctor({
      appId: 'hrms',
      root,
      env: { PRAMAAN_LLM_MODE: 'off' },
      fetchImpl: vi.fn<typeof fetch>(),
      browserPaths: fakeBrowsers,
    });
    const required = report.checks.find((c) => c.name === 'env (required)');
    expect(required?.status).toBe('fail');
    for (const key of [
      'HRMS_TENANT_PRIMARY',
      'HRMS_EMPLOYEE_EMAIL',
      'HRMS_EMPLOYEE_PASSWORD',
      'HRMS_ADMIN_EMAIL',
      'HRMS_ADMIN_PASSWORD',
    ]) {
      expect(required?.detail, `required key ${key} should be reported`).toContain(key);
    }
    expect(required?.detail).not.toContain('HRMS_EMPLOYEE2_EMAIL');
    const optional = report.checks.find((c) => c.name === 'env (optional)');
    expect(optional?.detail).toContain('HRMS_EMPLOYEE2_EMAIL');
    expect(optional?.detail).toContain('HRMS_TENANT_SECONDARY');
    expect(report.ok).toBe(false);
  });

  it('should_call_guarded_fetch_once_when_hrms_has_target_staging', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    const report = await runDoctor({
      appId: 'hrms',
      root,
      target: 'staging',
      env: { PRAMAAN_LLM_MODE: 'off' },
      fetchImpl,
      browserPaths: fakeBrowsers,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('hrms-staging.blgtechnologies.in');
    expect(report.checks.find((c) => c.name === 'reachability')?.status).toBe('pass');
  });

  it('should_fail_llm_check_when_live_mode_has_no_key', async () => {
    const report = await runDoctor({
      appId: 'hrms',
      root,
      env: { PRAMAAN_LLM_MODE: 'live' },
      fetchImpl: vi.fn<typeof fetch>(),
      browserPaths: fakeBrowsers,
    });
    expect(report.checks.find((c) => c.name === 'llm')?.status).toBe('fail');
  });
});

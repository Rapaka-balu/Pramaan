import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loadAppConfig, repoRoot } from '../../src/core/config.js';
import { Ledger } from '../../src/core/ledger.js';
import { runOnboard } from '../../src/onboarding/onboard.js';
import { loadAuthMaterial, sessionFiles } from '../../src/onboarding/sessions.js';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'pramaan-m1-'));

test.describe.configure({ mode: 'serial' });

test('should_log_in_all_six_demo_users_and_call_api_when_onboarding_demo', async () => {
  test.setTimeout(120_000);
  // Arrange
  const root = freshRoot();
  // Act
  const res = await runOnboard({ appId: 'demo', stateRoot: root });
  // Assert
  expect(res.exitCode, res.summary).toBe(0);
  expect(res.rows.map((r) => r.status), res.summary).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  const { config, env } = loadAppConfig('demo', { root: repoRoot() });
  for (const role of config.roles) {
    const material = loadAuthMaterial(root, 'demo', role.id);
    expect(material, `${role.id} should have stored auth material`).toBeDefined();
    const me = await fetch(new URL('/api/me', config.baseUrl), { headers: material?.headers ?? {} });
    expect(me.status, `${role.id}'s derived AuthMaterial should authenticate API calls`).toBe(200);
    const body = (await me.json()) as { email?: string; user?: { email?: string } };
    expect(body.email ?? body.user?.email, `${role.id} should be the logged-in user`).toBe(env[role.usernameEnv]);
  }
  expect(readFileSync(res.reportPath, 'utf8'), 'onboarding.md should list every role').toContain('| t2-employee');
  const blocked = new Ledger({ root, app: 'demo' }).query({ type: 'safety.blocked' });
  expect(blocked, 'login must not trip the safety guards').toHaveLength(0);
});

test('should_refresh_session_when_token_was_deleted_from_storage', async () => {
  test.setTimeout(60_000);
  // Arrange
  const root = freshRoot();
  await runOnboard({ appId: 'demo', stateRoot: root, roles: ['employee'] });
  const file = sessionFiles(root, 'demo', 'employee').state;
  const state = JSON.parse(readFileSync(file, 'utf8')) as { origins: { localStorage: { name: string }[] }[] };
  for (const o of state.origins) o.localStorage = o.localStorage.filter((kv) => kv.name !== 'demo.token');
  writeFileSync(file, JSON.stringify(state));
  // Act
  const res = await runOnboard({ appId: 'demo', stateRoot: root, roles: ['employee'] });
  // Assert
  expect(res.rows[0]?.status, 'a 401 on the first API call should trigger a fresh login').toBe('refreshed');
  const again = await runOnboard({ appId: 'demo', stateRoot: root, roles: ['employee'] });
  expect(again.rows[0]?.status, 'the refreshed session should then be reused').toBe('reused');
});

test('should_write_cannot_proceed_naming_role_and_error_when_password_is_wrong', async () => {
  test.setTimeout(60_000);
  // Arrange
  const root = freshRoot();
  // Act
  const res = await runOnboard({
    appId: 'demo',
    stateRoot: root,
    roles: ['admin'],
    env: { ...process.env, DEMO_PASSWORD: 'wrong-password' },
  });
  // Assert
  expect(res.exitCode, 'a failed required role should exit 2').toBe(2);
  expect(res.cannotProceedPath && existsSync(res.cannotProceedPath), 'cannot-proceed.md should exist').toBeTruthy();
  const md = readFileSync(res.cannotProceedPath ?? '', 'utf8');
  expect(md, 'cannot-proceed.md should name the role').toContain('`admin`');
  expect(md, 'cannot-proceed.md should quote the visible error text').toContain('Invalid credentials');
  expect(md, 'the password must never be written').not.toContain('wrong-password');
});

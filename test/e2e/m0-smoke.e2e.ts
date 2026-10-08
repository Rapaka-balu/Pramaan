import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..', '..');
const demoUrl = (): string => {
  const url = process.env['DEMO_URL'];
  if (!url) throw new Error('DEMO_URL not set by global setup');
  return url;
};

test('should_show_leave_balance_when_employee_logs_in_to_demo', async ({ page }) => {
  // Arrange
  await page.goto(`${demoUrl()}/login`);
  // Act
  await page.getByLabel('Tenant code').fill('TEST');
  await page.getByLabel('Email').fill('emp1@demo.local');
  await page.getByLabel('Password').fill('Demo@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Assert
  await expect(page, 'login should land on the dashboard').toHaveURL(/\/dashboard$/);
  await expect(page.getByText(/Leave balance: \d+(\.\d+)? days/), 'dashboard should show the balance').toBeVisible();
});

test('should_show_error_text_when_password_is_wrong', async ({ page }) => {
  await page.goto(`${demoUrl()}/login`);
  await page.getByLabel('Tenant code').fill('TEST');
  await page.getByLabel('Email').fill('emp1@demo.local');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert'), 'a visible error should explain the failed login').toContainText(/invalid/i);
});

test('should_pass_doctor_when_demo_app_is_running', () => {
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsx, 'src/cli/index.ts', 'doctor', '--app', 'demo'], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
  });
  expect(res.stdout, `doctor output:\n${res.stdout}\n${res.stderr}`).toContain('result: PASS');
  expect(res.status, 'doctor should exit 0 on the demo app').toBe(0);
});

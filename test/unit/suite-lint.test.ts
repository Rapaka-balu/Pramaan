import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { ESLINT_PLUGIN } from '../../src/codegen/static-files.js';

// The generated suite's own lint rules, loaded exactly as the suite loads them.
async function lint(code: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'pramaan-lint-'));
  const pluginPath = join(dir, 'pramaan.mjs');
  writeFileSync(pluginPath, ESLINT_PLUGIN);
  const plugin = ((await import(pathToFileURL(pluginPath).href)) as { default: ESLint.Plugin }).default;
  const eslint = new ESLint({
    cwd: dir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { pramaan: plugin },
        rules: { 'pramaan/no-wait-for-timeout': 'error', 'pramaan/no-fragile-locators': 'error', 'pramaan/expect-message': 'error', 'pramaan/test-title': 'error' },
      },
    ],
  });
  const [r] = await eslint.lintText(code, { filePath: join(dir, 'x.spec.ts') });
  return (r?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

const good = `test('should_deduct_days_when_leave_is_approved', { tag: ['@api'] }, async ({ page }) => {
  await page.getByTestId('apply').click();
  await page.locator('#export-csv').click();
  expect(1, 'one is one').toBe(1);
  await expect.poll(async () => 1, { message: 'polls' }).toBe(1);
});`;

describe('generated-suite lint rules', () => {
  it('accepts code that follows the house conventions', async () => {
    expect(await lint(good)).toEqual([]);
  });
  it('rejects hard-coded waits', async () => {
    expect(await lint(good.replace("await page.getByTestId('apply').click();", 'await page.waitForTimeout(500);'))).toEqual(['pramaan/no-wait-for-timeout']);
  });
  it.each([["page.locator('xpath=//button')"], ["page.locator('//div/button')"], ["page.locator('.btn-primary')"], ["page.locator('form .submit')"]])('rejects fragile locator %s', async (loc) => {
    expect(await lint(good.replace("page.locator('#export-csv')", loc))).toEqual(['pramaan/no-fragile-locators']);
  });
  it('rejects an expect without a message', async () => {
    expect(await lint(good.replace("expect(1, 'one is one')", 'expect(1)'))).toEqual(['pramaan/expect-message']);
  });
  it('rejects titles outside should_…_when_…, including tags in the title', async () => {
    expect(await lint(good.replace('should_deduct_days_when_leave_is_approved', 'deducts days @api'))).toEqual(['pramaan/test-title']);
    expect(await lint(good.replace("'should_deduct_days_when_leave_is_approved'", '`should_x_when_${1} y`'))).toEqual(['pramaan/test-title']);
  });
});

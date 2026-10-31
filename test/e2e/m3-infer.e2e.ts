import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import { Ledger } from '../../src/core/ledger.js';
import { runCrawl } from '../../src/crawler/crawl.js';
import { Steward } from '../../src/data/steward.js';
import { loadAuthMaterial } from '../../src/onboarding/sessions.js';
import { EntitiesFile } from '../../src/spec/entities.js';
import { runInfer } from '../../src/spec/infer.js';

interface LogEntry {
  method: string;
  path: string;
}
const demo = (): string => process.env['DEMO_URL'] ?? '';

test('should_infer_templates_and_confirm_lifecycle_transitions_when_inferring_the_demo', async () => {
  test.setTimeout(600_000);
  // Arrange
  await fetch(`${demo()}/__reset`, { method: 'POST' });
  const root = mkdtempSync(join(tmpdir(), 'pramaan-m3-'));
  const crawl = await runCrawl({ appId: 'demo', stateRoot: root, roles: ['employee', 'manager', 'admin'] });
  expect(crawl.exitCode, crawl.summary).toBe(0);
  await fetch(`${demo()}/__requests`, { method: 'DELETE' });

  // Act
  const res = await runInfer({ appId: 'demo', stateRoot: root });
  const openapi = readFileSync(join(res.specDir, 'openapi.observed.yaml'), 'utf8');
  const entities = EntitiesFile.parse(parseYaml(readFileSync(join(res.specDir, 'entities.yaml'), 'utf8')));
  const log = (await (await fetch(`${demo()}/__requests`)).json()) as LogEntry[];

  // Assert — every leave/employee operation the crawl exercised, with correct templates
  expect(res.exitCode, res.summary).toBe(0);
  for (const op of ['GET /api/leaves', 'POST /api/leaves', 'GET /api/leaves/{id}', 'POST /api/leaves/{id}/cancel', 'GET /api/employees', 'GET /api/approvals']) {
    expect(res.operations, `${op} should be in the observed spec`).toContain(op);
  }
  expect(res.operations.some((k) => /\/api\/leaves\/\d+/.test(k)), 'no concrete ids may remain in templates').toBe(false);
  expect(openapi, 'the OpenAPI file should be 3.1').toContain('openapi: 3.1.0');
  expect(openapi, 'no crawl-typed values may leak into the spec').not.toMatch(/PRM-\d{8}/);

  // Assert — state machine after the lifecycle probe
  const sm = entities.entities.find((e) => e.name === 'leave')?.stateMachine;
  const observed = (from: string, to: string): boolean => sm?.transitions.some((t) => t.from === from && t.to === to && t.observed) ?? false;
  expect(sm?.field, 'leave status should be the state field').toBe('status');
  expect(observed('submitted', 'approved'), 'submitted → approved should be observed by the probe').toBe(true);
  expect(observed('approved', 'cancelled'), 'approved → cancelled should be observed by the probe').toBe(true);

  // Assert — the probe touched only its own records and cleaned up
  const events = new Ledger({ root, app: 'demo' }).read();
  const owned = new Set(Steward.recordsOf(events, res.runId).map((r) => r.id));
  const foreign = log.filter((e) => {
    const id = /^\/api\/leaves\/(\d+)\//.exec(e.path)?.[1];
    return e.method !== 'GET' && id !== undefined && !owned.has(id);
  });
  expect(foreign, 'the probe must only mutate records it created').toEqual([]);
  expect(Steward.orphans(events, res.runId), 'probe records should all be torn down').toEqual([]);
  const balance = (await (await fetch(`${demo()}/api/leave-balance`, { headers: loadAuthMaterial(root, 'demo', 'employee')?.headers ?? {} })).json()) as { available: number };
  expect(balance.available, "the employee's balance should be back to the seed value").toBe(20);
});

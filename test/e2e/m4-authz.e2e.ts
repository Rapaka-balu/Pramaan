import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { confirmAll, loadMatrix, saveMatrix } from '../../src/authz/matrix-io.js';
import { runAuthz } from '../../src/authz/run.js';
import { Ledger } from '../../src/core/ledger.js';
import { workspaceDir } from '../../src/core/paths.js';
import { runCrawl } from '../../src/crawler/crawl.js';
import { Steward } from '../../src/data/steward.js';
import { startDemo } from '../../fixtures/demo-hrms/server.mjs';
import { runInfer } from '../../src/spec/infer.js';

interface LogEntry {
  method: string;
  path: string;
}
const AUTHZ_BUGS = 'idor-leave-read,employee-admin-endpoint,cross-tenant-list';

async function pipeline(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const crawl = await runCrawl({ appId: 'demo', stateRoot: root, env });
  expect(crawl.exitCode, crawl.summary).toBe(0);
  const infer = await runInfer({ appId: 'demo', stateRoot: root, env });
  expect(infer.exitCode, infer.summary).toBe(0);
}

test.describe.configure({ mode: 'serial' });
let cleanRoot = '';

test('should_report_zero_authz_findings_when_the_confirmed_matrix_replays_on_a_clean_demo', async () => {
  test.setTimeout(600_000);
  // Arrange
  const demo = process.env['DEMO_URL'] ?? '';
  await fetch(`${demo}/__reset`, { method: 'POST' });
  cleanRoot = mkdtempSync(join(tmpdir(), 'pramaan-m4-clean-'));
  await pipeline(cleanRoot, process.env);
  const first = await runAuthz({ appId: 'demo', stateRoot: cleanRoot });
  expect(first.exitCode, first.summary).toBe(0);
  expect(first.questions, `clean demo should raise no authz questions\n${first.summary}`).toEqual([]);
  // Scripted review: the lead confirms the proposed matrix.
  saveMatrix(first.matrixPath, confirmAll(loadMatrix(first.matrixPath), 'lead:scripted-review'));
  await fetch(`${demo}/__requests`, { method: 'DELETE' });

  // Act
  const res = await runAuthz({ appId: 'demo', stateRoot: cleanRoot });
  const log = (await (await fetch(`${demo}/__requests`)).json()) as LogEntry[];

  // Assert
  console.log(res.summary);
  expect(res.findings, res.summary).toEqual([]);
  const ops = res.matrix.rows.map((r) => r.operation);
  for (const op of ['GET /api/leaves/{id}', 'GET /api/employees', 'GET /api/leaves?all', 'POST /api/leaves/{id}/approve']) {
    expect(ops, `the matrix should have a row for ${op}`).toContain(op);
  }
  const events = new Ledger({ root: cleanRoot, app: 'demo' }).read();
  const owned = new Set(Steward.recordsOf(events, res.runId).map((r) => r.id));
  const foreign = log.filter((e) => {
    const id = /^\/api\/leaves\/(\d+)\//.exec(e.path)?.[1];
    return e.method !== 'GET' && id !== undefined && !owned.has(id);
  });
  expect(foreign, 'authz replay must never mutate a record outside the teardown ledger').toEqual([]);
  expect(Steward.orphans(events, res.runId), 'replay records should all be torn down').toEqual([]);
});

test('should_find_idor_admin_endpoint_and_cross_tenant_bugs_when_replaying_the_confirmed_matrix', async () => {
  test.setTimeout(600_000);
  // Arrange: the same confirmed matrix, against a demo with the three authz bugs switched on.
  const bugged = await startDemo({ port: 0, env: { ...process.env, DEMO_BUGS: AUTHZ_BUGS } });
  try {
    const env = { ...process.env, DEMO_PORT: String(bugged.port) };
    const root = mkdtempSync(join(tmpdir(), 'pramaan-m4-bugs-'));
    await pipeline(root, env);
    const specDir = workspaceDir(root, 'demo', 'spec');
    mkdirSync(specDir, { recursive: true });
    copyFileSync(join(workspaceDir(cleanRoot, 'demo', 'spec'), 'role-matrix.yaml'), join(specDir, 'role-matrix.yaml'));

    // Act
    const res = await runAuthz({ appId: 'demo', stateRoot: root, env });

    // Assert
    console.log(res.summary);
    const hit = (operation: string, actor: string): boolean => res.findings.some((f) => f.title.startsWith(`${actor} got`) && f.title.includes(` on ${operation};`));
    expect(hit('GET /api/leaves/{id}', 'employee2'), `idor-leave-read should be found\n${res.summary}`).toBe(true);
    expect(hit('GET /api/employees', 'employee'), `employee-admin-endpoint should be found\n${res.summary}`).toBe(true);
    expect(hit('GET /api/leaves?all', 'other-tenant:t2-admin'), `cross-tenant-list should be found\n${res.summary}`).toBe(true);
    expect(res.findings.every((f) => f.oracle === 'authz-matrix' && f.status === 'queued'), 'findings are authz-matrix and queued (no precision record yet)').toBe(true);
  } finally {
    await bugged.close();
  }
});

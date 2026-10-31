import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Ledger, ledgerPath } from '../../src/core/ledger.js';
import { runCrawl } from '../../src/crawler/crawl.js';
import { runOrphans, runSeed, runTeardown } from '../../src/data/commands.js';
import { Steward } from '../../src/data/steward.js';
import { runInfer } from '../../src/spec/infer.js';

test.describe.configure({ mode: 'serial' });
let root = '';

test('should_clean_up_with_teardown_run_when_a_crawl_is_killed_halfway', async () => {
  test.setTimeout(600_000);
  // Arrange: a Living Spec exists (as on staging after the first crawl + infer)
  await fetch(`${process.env['DEMO_URL'] ?? ''}/__reset`, { method: 'POST' });
  root = mkdtempSync(join(tmpdir(), 'pramaan-m7-'));
  expect((await runCrawl({ appId: 'demo', stateRoot: root, roles: ['employee', 'manager'] })).exitCode).toBe(0);
  expect((await runInfer({ appId: 'demo', stateRoot: root })).exitCode).toBe(0);
  const before = new Ledger({ root, app: 'demo' }).query({ type: 'data.created' }).length;

  // Act 1: a second crawl in its own process, killed as soon as it has created test data
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'crawl', '--app', 'demo', '--role', 'employee'], {
    env: { ...process.env, PRAMAAN_STATE_ROOT: root },
    stdio: 'ignore',
  });
  await expect
    .poll(() => (existsSync(ledgerPath(root, 'demo')) ? new Ledger({ root, app: 'demo' }).query({ type: 'data.created' }).length : 0), {
      message: 'the second crawl should create test data before it is killed',
      timeout: 120_000,
    })
    .toBeGreaterThan(before);
  child.kill('SIGINT');
  await new Promise((r) => child.once('exit', r));
  const created = new Ledger({ root, app: 'demo' }).query({ type: 'data.created' }).slice(before);
  const runId = created[0]?.runId ?? '';
  const leftBehind = Steward.orphans(new Ledger({ root, app: 'demo' }).read(), runId);

  // Act 2
  const res = await runTeardown({ appId: 'demo', stateRoot: root, runId });

  // Assert
  expect(leftBehind.length, 'the killed run should have left records without teardown').toBeGreaterThan(0);
  expect(res.exitCode, res.summary).toBe(0);
  expect(Steward.orphans(new Ledger({ root, app: 'demo' }).read(), runId), 'every record of the killed run should be torn down or retired').toEqual([]);
  const live = await runOrphans({ appId: 'demo', stateRoot: root, runId });
  expect(live.report?.live ?? [], `no record of the killed run may stay live\n${live.summary}`).toEqual([]);
});

test('should_find_seeded_records_live_then_none_when_seeding_and_tearing_down', async () => {
  test.setTimeout(300_000);
  // Act
  const seeded = await runSeed({ appId: 'demo', stateRoot: root, entity: 'leave', count: 3 });
  const during = await runOrphans({ appId: 'demo', stateRoot: root, runId: seeded.runId });
  const down = await runTeardown({ appId: 'demo', stateRoot: root, runId: seeded.runId });
  const after = await runOrphans({ appId: 'demo', stateRoot: root, runId: seeded.runId });

  // Assert
  expect(seeded.created, seeded.summary).toHaveLength(3);
  expect(during.report?.live.map((r) => r.id).sort(), 'seeded records are live and found by tag').toEqual([...seeded.created].sort());
  expect(down.exitCode, down.summary).toBe(0);
  expect(after.report?.live ?? [], after.summary).toEqual([]);
  expect(after.report?.retired.length, 'torn-down records end retired (cancelled)').toBe(3);
});

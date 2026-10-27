import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Ledger } from '../../src/core/ledger.js';
import { workspaceDir } from '../../src/core/paths.js';
import { runCrawl, type CrawlResult } from '../../src/crawler/crawl.js';
import { Steward } from '../../src/data/steward.js';
import { loadAuthMaterial } from '../../src/onboarding/sessions.js';

interface LogEntry {
  method: string;
  path: string;
  status: number;
  userId: number | null;
}
const demo = (): string => process.env['DEMO_URL'] ?? '';
const resetDemo = async (): Promise<void> => {
  await fetch(`${demo()}/__reset`, { method: 'POST' });
  await fetch(`${demo()}/__requests`, { method: 'DELETE' });
};
const requestLog = async (): Promise<LogEntry[]> => (await (await fetch(`${demo()}/__requests`)).json()) as LogEntry[];
const stateKeys = (root: string, role: string): string[] => {
  const s = JSON.parse(readFileSync(workspaceDir(root, 'demo', 'crawl', role, 'crawl-summary.json'), 'utf8')) as { stateIndex: { key: string }[] };
  return s.stateIndex.map((x) => x.key).sort();
};

// Routes the demo app defines, per role (approvals: manager/admin; employees: admin only).
const BASE = ['/dashboard', '/leaves', '/leaves/apply', '/leaves/{id}', '/attendance'];
const EXPECTED: Record<string, string[]> = {
  employee: BASE,
  employee2: BASE,
  manager: [...BASE, '/approvals'],
  admin: [...BASE, '/approvals', '/employees'],
  't2-admin': [...BASE, '/approvals', '/employees'],
  't2-employee': BASE,
};
// Seed balances (available days) and seeded leave statuses.
const SEED_AVAILABLE: Record<string, number> = { employee: 20, employee2: 19, manager: 20, admin: 20 };

test.describe.configure({ mode: 'serial' });

let root = '';
let res: CrawlResult;

test('should_discover_routes_safely_and_tear_down_when_crawling_every_demo_role', async () => {
  test.setTimeout(600_000);
  // Arrange
  await resetDemo();
  root = mkdtempSync(join(tmpdir(), 'pramaan-m2-'));

  // Act
  res = await runCrawl({ appId: 'demo', stateRoot: root });
  const log = await requestLog();
  const events = new Ledger({ root, app: 'demo' }).read();

  // Assert — coverage and time
  expect(res.exitCode, res.summary).toBe(0);
  expect(res.roles.map((r) => r.role), res.summary).toEqual(Object.keys(EXPECTED));
  for (const r of res.roles) {
    const want = EXPECTED[r.role] ?? [];
    const found = want.filter((route) => r.routes.includes(route));
    expect(found.length / want.length, `${r.role} should discover at least 90% of its routes (found ${r.routes.join(', ')})`).toBeGreaterThanOrEqual(0.9);
    expect(r.durationMs, `${r.role} crawl should take under 5 minutes`).toBeLessThan(5 * 60_000);
    expect(r.errors, `${r.role} crawl should finish without errors`).toEqual([]);
  }

  // Assert — no mutating request ever reached a record this run did not create
  const owned = new Set(Steward.recordsOf(events, res.runId).map((r) => r.id));
  const mutating = log.filter((e) => e.method !== 'GET' && !e.path.startsWith('/api/auth/'));
  const foreign = mutating.filter((e) => {
    const id = /^\/api\/leaves\/(\d+)/.exec(e.path)?.[1];
    return id !== undefined ? !owned.has(id) : e.path !== '/api/leaves';
  });
  expect(foreign, 'no mutating request may target a record Pramaan did not create').toEqual([]);
  expect(owned.size, 'the crawl should create records through allow-listed forms').toBeGreaterThan(0);

  // Assert — the owned-record cancel is exercised during the crawl, and protected rows were blocked
  expect(res.teardown?.retired.length ?? 0, 'some owned leaves should already be cancelled by the crawl itself').toBeGreaterThan(0);
  const blocked = events.filter((e) => e.type === 'safety.blocked' && e.runId === res.runId);
  expect(
    blocked.some((e) => e.data['pattern'] === 'cancel' && e.data['route'] === '/leaves' && e.data['role'] === 'employee'),
    "cancelling the employee's seeded leave should be blocked and logged",
  ).toBe(true);

  // Assert — approval-gated actions skipped and listed
  expect(log.filter((e) => e.path.startsWith('/api/attendance/punch')), 'punch in/out must never be called').toEqual([]);
  for (const r of res.roles) expect(r.needsApproval, `${r.role} should list the skipped punch actions`).toEqual(['Punch in', 'Punch out']);

  // Assert — teardown leaves the seed state, except terminal-state (cancelled) records
  expect(res.teardown?.orphaned ?? [], 'teardown should leave no orphans').toEqual([]);
  expect(Steward.orphans(new Ledger({ root, app: 'demo' }).read(), res.runId), 'the ledger should show every record torn down').toEqual([]);
  for (const [role, available] of Object.entries(SEED_AVAILABLE)) {
    const headers = loadAuthMaterial(root, 'demo', role)?.headers ?? {};
    const balance = (await (await fetch(`${demo()}/api/leave-balance`, { headers })).json()) as { available: number };
    expect(balance.available, `${role}'s balance should be back to the seed value`).toBe(available);
    const leaves = (await (await fetch(`${demo()}/api/leaves`, { headers })).json()) as { reason: string; status: string }[];
    for (const l of leaves.filter((x) => x.reason.startsWith('PRM-'))) {
      expect(l.status, `${role}'s crawl-created leave should end cancelled`).toBe('cancelled');
    }
  }
  const empHeaders = loadAuthMaterial(root, 'demo', 'employee')?.headers ?? {};
  const seeded = (await (await fetch(`${demo()}/api/leaves/1`, { headers: empHeaders })).json()) as { status: string };
  expect(seeded.status, "the employee's seeded leave must be untouched").toBe('submitted');
});

test('should_produce_the_same_state_keys_when_crawling_an_unchanged_demo_twice', async () => {
  test.setTimeout(300_000);
  // Arrange
  const roles = ['employee', 'manager'];
  const first = mkdtempSync(join(tmpdir(), 'pramaan-m2-a-'));
  const second = mkdtempSync(join(tmpdir(), 'pramaan-m2-b-'));

  // Act
  await resetDemo();
  await runCrawl({ appId: 'demo', stateRoot: first, roles });
  await resetDemo();
  await runCrawl({ appId: 'demo', stateRoot: second, roles });

  // Assert
  for (const role of roles) {
    expect(stateKeys(second, role), `${role}'s state keys should be identical across crawls`).toEqual(stateKeys(first, role));
  }
});

test('should_abort_foreign_mutations_at_the_network_layer_when_a_deny_pattern_is_missing', async () => {
  test.setTimeout(300_000);
  // Arrange: simulate a safety-list miss — cancel/approve/reject are no longer deny patterns.
  await resetDemo();
  const dir = mkdtempSync(join(tmpdir(), 'pramaan-m2-net-'));
  const missing = new Set(['cancel', 'approve', 'reject']);

  // Act
  const r = await runCrawl({
    appId: 'demo',
    stateRoot: dir,
    roles: ['employee', 'manager'],
    adjustConfig: (c) => ({ ...c, safety: { ...c.safety, denyActionPatterns: c.safety.denyActionPatterns.filter((p) => !missing.has(p)) } }),
  });
  const log = await requestLog();
  const events = new Ledger({ root: dir, app: 'demo' }).read();

  // Assert
  const net = events.filter((e) => e.type === 'safety.blocked' && e.data['layer'] === 'network');
  expect(net.length, 'the ownership guard should abort the clicks the UI layer missed').toBeGreaterThan(0);
  expect(
    net.some((e) => e.data['path'] === '/api/leaves/1/cancel' && e.data['method'] === 'POST'),
    "cancelling the employee's seeded leave 1 should be aborted at the network layer",
  ).toBe(true);
  const owned = new Set(Steward.recordsOf(events, r.runId).map((x) => x.id));
  const foreign = log.filter((e) => {
    const id = /^\/api\/leaves\/(\d+)\//.exec(e.path)?.[1];
    return e.method !== 'GET' && id !== undefined && !owned.has(id);
  });
  expect(foreign, 'no foreign mutation may reach the server even with a missing deny pattern').toEqual([]);
  const empHeaders = loadAuthMaterial(dir, 'demo', 'employee')?.headers ?? {};
  const seeded = (await (await fetch(`${demo()}/api/leaves/1`, { headers: empHeaders })).json()) as { status: string };
  expect(seeded.status, 'the seeded leave must still be submitted').toBe('submitted');
});

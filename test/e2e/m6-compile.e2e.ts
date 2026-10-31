import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { confirmAll, loadMatrix, saveMatrix } from '../../src/authz/matrix-io.js';
import { runAuthz } from '../../src/authz/run.js';
import { runCompile } from '../../src/codegen/compile.js';
import { runSuite } from '../../src/codegen/run-suite.js';
import { run } from '../../src/codegen/writer.js';
import { Ledger } from '../../src/core/ledger.js';
import { runCrawl } from '../../src/crawler/crawl.js';
import { runOrphans } from '../../src/data/commands.js';
import { runBench } from '../../src/bench/run.js';
import { runMutate } from '../../src/mutation/runner.js';
import { runTriage, Quarantine } from '../../src/triage/run.js';
import { TestIndex } from '../../src/bench/run.js';
import { gitChanges, lintChanges } from '../../src/maintain/expect-lint.js';
import { workspaceDir } from '../../src/core/paths.js';
import { Finding } from '../../src/core/schemas.js';
import { startDemo } from '../../fixtures/demo-hrms/server.mjs';
import { loadAssertions, saveAssertion } from '../../src/spec/assertion-proposer.js';
import { runInfer } from '../../src/spec/infer.js';
import { decide, loadRules, saveRules } from '../../src/spec/rule-proposer.js';

const LLM_WORDS = /openai|anthropic|generativelanguage|groq|openrouter|11434/i;

interface Report {
  suites: Report[];
  specs?: { title: string; file: string; ok: boolean }[];
}
function failedSpecs(resultsPath: string): string[] {
  const out: string[] = [];
  const walk = (s: Report): void => {
    for (const spec of s.specs ?? []) if (!spec.ok) out.push(`${spec.file} > ${spec.title}`);
    for (const c of s.suites ?? []) walk(c);
  };
  walk(JSON.parse(readFileSync(resultsPath, 'utf8')) as Report);
  return out;
}
function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === 'node_modules' || f === '.git' || f === 'package-lock.json') return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? codeFiles(p) : [p];
  });
}

test.describe.configure({ mode: 'serial' });
let root = '';
let repo = '';

test('should_compile_an_llm_free_suite_that_passes_when_the_demo_has_no_bugs', async () => {
  test.setTimeout(1_200_000);
  // Arrange: the full pipeline plus a scripted lead review
  await fetch(`${process.env['DEMO_URL'] ?? ''}/__reset`, { method: 'POST' });
  root = mkdtempSync(join(tmpdir(), 'pramaan-m6-'));
  repo = mkdtempSync(join(tmpdir(), 'pramaan-m6-suite-'));
  expect((await runCrawl({ appId: 'demo', stateRoot: root })).exitCode).toBe(0);
  const first = await runInfer({ appId: 'demo', stateRoot: root });
  const authz = await runAuthz({ appId: 'demo', stateRoot: root });
  saveMatrix(authz.matrixPath, confirmAll(loadMatrix(authz.matrixPath), 'lead:scripted'));
  const rulesPath = join(first.specDir, 'rules.yaml');
  saveRules(rulesPath, loadRules(rulesPath).map((r) => (r.status === 'proposed' ? decide(r, r.title.includes('DD/MM') ? 'rejected' : 'confirmed', 'lead:scripted') : r)));
  const second = await runInfer({ appId: 'demo', stateRoot: root });
  const dir = join(second.specDir, 'assertions');
  for (const a of loadAssertions(dir)) saveAssertion(dir, { ...a, status: 'confirmed', decision: { by: 'lead:scripted', at: '2026-10-31T21:00:00+05:30' } });
  const llmBefore = new Ledger({ root, app: 'demo' }).query({ type: 'llm.call' }).length;

  // Act
  const compiled = await runCompile({ appId: 'demo', stateRoot: root, repoPath: repo });
  console.log(compiled.summary);
  const ci = run('npm', ['ci', '--no-audit', '--no-fund'], repo);
  const res = await runSuite({ appId: 'demo', stateRoot: root, repoPath: repo, suite: 'all' });
  console.log(res.summary);

  // Assert — compiled, lint/typecheck clean, and green on a clean demo
  expect(compiled.exitCode, compiled.summary).toBe(0);
  expect(compiled.checks, 'the suite typechecks and passes its own lint').toMatchObject({ typecheck: true, lint: true });
  expect(ci.status, `npm ci should work in the suite\n${ci.out.slice(-1500)}`).toBe(0);
  expect(res.stats.unexpected, `every generated test should pass on DEMO_BUGS=none\n${res.output.slice(-4000)}`).toBe(0);
  expect(res.stats.expected, 'the suite should contain smoke, rule, authz and consistency tests').toBeGreaterThan(30);

  // Assert — LLM-free three ways
  const pkg = readFileSync(join(repo, 'package.json'), 'utf8') + readFileSync(join(repo, 'package-lock.json'), 'utf8');
  expect(pkg, 'no LLM SDK in package.json or the lockfile').not.toMatch(/"(openai|@anthropic-ai\/sdk)"|node_modules\/openai|node_modules\/@anthropic-ai/);
  const hits = codeFiles(repo).filter((f) => LLM_WORDS.test(readFileSync(f, 'utf8')));
  expect(hits, 'no LLM provider names anywhere in the suite code').toEqual([]);
  const llmCalls = new Ledger({ root, app: 'demo' }).query({ type: 'llm.call' }).slice(llmBefore);

  // Assert — M7: after compile, run and teardown, no tagged record is left live anywhere
  const orphans = await runOrphans({ appId: 'demo', stateRoot: root });
  expect(orphans.report?.live ?? [], orphans.summary).toEqual([]);
  expect(llmCalls.filter((e) => e.data['cached'] !== true), 'compile makes no uncached LLM calls').toEqual([]);
});

test('should_produce_zero_diff_when_compiling_twice_without_input_changes', async () => {
  test.setTimeout(300_000);
  // Arrange: absorb the previous suite run (its run.completed is mirrored into spec/decisions.jsonl — a real input)
  expect((await runCompile({ appId: 'demo', stateRoot: root, repoPath: repo })).exitCode).toBe(0);
  // Act
  const again = await runCompile({ appId: 'demo', stateRoot: root, repoPath: repo });
  // Assert
  expect(again.exitCode, again.summary).toBe(0);
  expect(again.written, 'no file should be rewritten').toBe(0);
  expect(again.branch, 'no new compile branch without changes').toBeUndefined();
  expect(run('git', ['status', '--porcelain'], repo).out.trim(), 'the suite repo should be clean').toBe('');
});

test('should_fail_only_the_consistency_tests_when_the_ui_balance_is_stale', async () => {
  test.setTimeout(600_000);
  const demo = await startDemo({ port: 0, env: { ...process.env, DEMO_BUGS: 'stale-ui-balance' } });
  try {
    // Act
    const res = await runSuite({ appId: 'demo', stateRoot: root, repoPath: repo, suite: 'regression', env: { ...process.env, DEMO_PORT: String(demo.port) } });
    // Assert
    const failed = failedSpecs(res.resultsPath ?? '');
    expect(failed.length, `consistency tests should fail on a stale UI balance\n${res.summary}`).toBeGreaterThan(0);
    expect(failed.every((f) => f.includes('consistency.spec.ts')), `only consistency tests may fail:\n${failed.join('\n')}`).toBe(true);
  } finally {
    await demo.close();
  }
});

test('should_fail_the_authz_matrix_spec_when_the_three_authz_bugs_are_on', async () => {
  test.setTimeout(600_000);
  const demo = await startDemo({ port: 0, env: { ...process.env, DEMO_BUGS: 'idor-leave-read,employee-admin-endpoint,cross-tenant-list' } });
  try {
    // Act
    const res = await runSuite({ appId: 'demo', stateRoot: root, repoPath: repo, suite: 'authz', env: { ...process.env, DEMO_PORT: String(demo.port) } });
    // Assert
    const failed = failedSpecs(res.resultsPath ?? '');
    for (const want of ['for_employee2_when_calling_get_api_leaves_id', 'for_employee_when_calling_get_api_employees', 'for_other_tenant_t2_admin_when_calling_get_api_leaves_all']) {
      expect(failed.some((f) => f.includes(want)), `${want} should fail\n${failed.join('\n')}`).toBe(true);
    }
  } finally {
    await demo.close();
  }
});

test('should_detect_seeded_bugs_without_false_alarms_when_benchmarking_the_suite', async () => {
  test.setTimeout(900_000);
  // Act: a short bench (the full 14-bug bench is `pramaan bench --app demo`, measured in PROGRESS.md)
  const res = await runBench({ appId: 'demo', stateRoot: root, repoPath: repo, bugs: ['balance-off-by-one', 'idor-leave-read', 'stale-ui-balance'] });
  console.log(res.summary);
  // Assert
  expect(res.exitCode, res.summary).toBe(0);
  expect(res.report?.falseAlarmsOnNone, 'no failure at all on DEMO_BUGS=none').toBe(0);
  expect(res.report?.runs.filter((r) => r.bug !== 'none' && !r.detected).map((r) => r.bug), 'every bug in this subset is caught by its expected oracle').toEqual([]);
  expect(new Ledger({ root, app: 'demo' }).query({ type: 'bench.result' }).length, 'the bench result is in the ledger').toBeGreaterThan(0);
});

test('should_kill_injected_faults_when_mutating_the_leave_balance_operation', async () => {
  test.setTimeout(900_000);
  // Act: one operation's faults (the full run is `pramaan mutate --app demo`)
  const res = await runMutate({ appId: 'demo', stateRoot: root, repoPath: repo, ops: ['GET /api/leave-balance'] });
  console.log(res.summary);
  // Assert
  expect(res.exitCode, res.summary).toBe(0);
  expect(res.report?.mutants ?? 0, 'mutants were planned and run').toBeGreaterThan(5);
  expect(res.report?.killRate ?? 0, `kill rate on the balance operation\n${res.summary}`).toBeGreaterThanOrEqual(0.7);
  expect(res.report?.baselineFailures, 'tests pass without faults').toEqual([]);
});

// ---------------------------------------------------------------- M9: triage, heal, quarantine

async function triageAgainst(demoEnv: Record<string, string>): Promise<{ triage: Awaited<ReturnType<typeof runTriage>>; branchBefore: string }> {
  const branchBefore = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo).out.trim();
  const demo = await startDemo({ port: 0, env: { ...process.env, DEMO_BUGS: 'none', ...demoEnv } });
  try {
    const env = { ...process.env, DEMO_PORT: String(demo.port) };
    const res = await runSuite({ appId: 'demo', stateRoot: root, repoPath: repo, suite: 'regression', env });
    const triage = await runTriage({ appId: 'demo', stateRoot: root, repoPath: repo, results: res.resultsPath ?? '', env });
    console.log(triage.summary);
    return { triage, branchBefore };
  } finally {
    await demo.close();
  }
}

test('should_file_a_queued_confirmed_rule_finding_when_the_balance_is_off_by_one', async () => {
  test.setTimeout(900_000);
  // Act
  const { triage } = await triageAgainst({ DEMO_BUGS: 'balance-off-by-one' });
  // Assert
  const bug = triage.items.find((i) => i.title.startsWith('should_deduct_exactly_the_requested_days'));
  expect(bug?.cls, 'the deduction test failure is a product bug candidate').toBe('product-bug-candidate');
  const finding = Finding.parse(JSON.parse(readFileSync(join(workspaceDir(root, 'demo', 'findings'), `${bug?.findingId ?? ''}.json`), 'utf8')));
  expect(finding.oracle, 'found by the confirmed rule').toBe('confirmed-rule');
  expect(finding.status, 'a fresh ledger has no precision record: queued, not auto-filed').toBe('queued');
  expect(finding.evidence[0]?.excerpt ?? '', 'evidence quotes expected and received').toMatch(/Expected: -2[\s\S]*Received: -3/);
  expect(triage.items.every((i) => i.cls === 'product-bug-candidate'), 'nothing else is wrong with this build').toBe(true);
});

test('should_quarantine_and_never_file_flaky_balance_tests_when_the_api_is_flaky', async () => {
  test.setTimeout(900_000);
  // Act (DEMO_SEED=21 makes the 503 pattern reproducible; every affected test passes at least one rerun)
  const { triage, branchBefore } = await triageAgainst({ DEMO_FLAKY: '0.3', DEMO_SEED: '21' });
  try {
    // Assert
    expect(triage.items.length, 'the flaky API makes some tests fail').toBeGreaterThan(0);
    expect(triage.items.map((i) => i.cls).filter((c) => c !== 'flaky'), `every failure is flaky\n${triage.summary}`).toEqual([]);
    expect(triage.items.filter((i) => i.findingId), 'flaky tests are never filed').toEqual([]);
    const q = Quarantine.parse(JSON.parse(readFileSync(join(repo, 'quarantine.json'), 'utf8')));
    expect(q.tests.map((t) => t.title).sort(), 'all of them are quarantined').toEqual(triage.items.map((i) => i.title).sort());
    const index = TestIndex.parse(JSON.parse(readFileSync(join(repo, 'spec', 'test-index.json'), 'utf8'))).tests;
    for (const i of triage.items) {
      const ops = index.find((e) => e.title === i.title)?.operations ?? [];
      expect(ops, `${i.title} reads the flaky /api/leave-balance`).toContain('GET /api/leave-balance');
    }
  } finally {
    run('git', ['checkout', '-q', branchBefore], repo);
  }
});

test('should_heal_only_the_page_object_when_the_apply_button_testid_drifts', async () => {
  test.setTimeout(900_000);
  // Act
  const { triage, branchBefore } = await triageAgainst({ DEMO_DRIFT: 'apply-testid' });
  try {
    // Assert
    expect(triage.items.map((i) => i.cls), triage.summary).toEqual(['locator-drift']);
    expect(triage.items[0]?.action ?? '', 'healed, re-run green, lint ok').toMatch(/^healed pages\/LeavesApplyPage\.ts .*"apply-leave-btn".*"apply-leave-submit".*test passes, lint ok$/);
    const changed = run('git', ['diff', '--name-only', `${branchBefore}...HEAD`], repo).out.split('\n').filter(Boolean);
    expect(changed, 'the heal commit touches pages/ only').toEqual(['pages/LeavesApplyPage.ts']);
    expect(lintChanges(gitChanges(repo, branchBefore), { healPr: true }), 'the suite heal lint passes on the heal branch').toEqual([]);
    expect(new Ledger({ root, app: 'demo' }).query({ type: 'heal.applied' }).length, 'heal.applied is in the ledger').toBeGreaterThan(0);
  } finally {
    run('git', ['checkout', '-q', branchBefore], repo);
  }
});

// `pramaan mutate` (§8 M8): runs each fault against the tests it applies to. Killed = the test fails under the fault.
// Kill rate = killed / (killed + survived); delay-2s is a robustness probe (a failure there is fragility, not a kill).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TestIndex } from '../bench/run.js';
import { activate, freePort, type Target } from '../bench/target.js';
import { runSuite } from '../codegen/run-suite.js';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { newRunId } from '../core/run-id.js';
import { networkAllowed } from '../onboarding/contract.js';
import { parseResults } from '../triage/parse.js';
import { planMutants, shapesFromOpenApi, specString, titlesRegex, type FaultSpec } from './faults.js';

export interface MutantResult {
  spec: string;
  test: string;
  killed: boolean;
}
export interface MutationReport {
  runId: string;
  app: string;
  mutants: number;
  /** Fault never fired for the test: equivalent, not counted. */
  equivalent: number;
  killed: number;
  survived: number;
  killRate: number;
  byKind: Record<string, { killed: number; survived: number }>;
  weakTests: string[]; // ≥ 1 mutant, 0 kills
  fragile: { spec: string; test: string }[]; // failed under delay-2s
  survivors: MutantResult[];
  baselineFailures: string[];
  durationMs: number;
}

export interface MutateOptions {
  appId: string;
  stateRoot: string;
  repoPath?: string;
  /** Limit to these operations (e.g. ["GET /api/leave-balance"]). */
  ops?: string[];
  target?: 'staging' | undefined;
  env?: NodeJS.ProcessEnv;
}

export async function runMutate(opts: MutateOptions): Promise<{ exitCode: 0 | 2; report?: MutationReport; reportPath?: string; summary: string }> {
  const root = repoRoot();
  const loaded = loadAppConfig(opts.appId, opts.env ? { root, env: opts.env } : { root });
  const { config } = loaded;
  if (!networkAllowed(loaded, opts.target)) return { exitCode: 2, summary: `pramaan mutate — no network calls made: ${config.id} needs --target staging` };
  const repo = opts.repoPath ?? (isAbsolute(config.output.repoPath) ? config.output.repoPath : resolve(root, config.output.repoPath));
  const indexPath = join(repo, 'spec', 'test-index.json');
  if (!existsSync(indexPath)) return { exitCode: 2, summary: `pramaan mutate — no compiled suite at ${repo}: run \`pramaan compile\` first` };
  const index = TestIndex.parse(JSON.parse(readFileSync(indexPath, 'utf8'))).tests;
  const openapi = existsSync(join(repo, 'spec', 'openapi.observed.yaml')) ? (parseYaml(readFileSync(join(repo, 'spec', 'openapi.observed.yaml'), 'utf8')) as unknown) : {};
  const plan = planMutants(index, shapesFromOpenApi(openapi), opts.ops);
  const runId = newRunId();
  const started = Date.now();
  const dir = workspaceDir(opts.stateRoot, config.id, 'mutation', runId);
  mkdirSync(dir, { recursive: true });

  // The demo restarts clean (DEMO_BUGS=none) on a fixed port; other apps must already be up.
  const port = await freePort();
  const target: Target | undefined = config.id === 'demo' ? await activate('demo', { env: { DEMO_BUGS: 'none' } }, { port }) : undefined;
  let runs = 0;
  const runWith = async (titles: string[], fault?: FaultSpec): Promise<{ ok: Map<string, boolean>; fired: Map<string, number> }> => {
    const grep = join(dir, `grep-${runs}.txt`);
    const faultLog = join(dir, `fired-${runs}.jsonl`);
    writeFileSync(grep, titlesRegex(titles));
    writeFileSync(faultLog, '');
    const res = await runSuite({
      appId: opts.appId,
      stateRoot: opts.stateRoot,
      repoPath: repo,
      suite: 'all',
      target: opts.target,
      env: {
        ...(opts.env ?? process.env),
        ...(target ? { DEMO_PORT: String(port) } : {}),
        PRAMAAN_GREP_FILE: grep,
        ...(runs > 0 ? { PRAMAAN_REUSE_AUTH: '1' } : {}),
        ...(fault ? { PRAMAAN_FAULT: specString(fault), PRAMAAN_FAULT_LOG: faultLog } : {}),
      },
    });
    runs += 1;
    const ok = new Map<string, boolean>();
    if (res.resultsPath) for (const t of parseResults(res.resultsPath)) ok.set(t.title, t.ok);
    const fired = new Map<string, number>();
    for (const line of readFileSync(faultLog, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line) as { title: string; fired: number };
      fired.set(e.title, (fired.get(e.title) ?? 0) + e.fired);
    }
    return { ok, fired };
  };

  const results: MutantResult[] = [];
  let equivalent = 0;
  const fragile: MutationReport['fragile'] = [];
  let baselineFailures: string[];
  try {
    const all = [...new Set([...plan.specs.values(), ...plan.robustness.values()].flatMap((s) => s.tests))];
    const baseline = (await runWith(all)).ok;
    baselineFailures = all.filter((t) => baseline.get(t) !== true);
    const healthy = (t: string): boolean => baseline.get(t) === true;
    for (const { spec, tests } of [...plan.specs.values()].sort((a, b) => specString(a.spec).localeCompare(specString(b.spec)))) {
      const run = tests.filter(healthy);
      if (run.length === 0) continue;
      const out = await runWith(run, spec);
      for (const t of run) {
        if (!out.ok.has(t)) continue;
        // A fault that never changed a response this test received is an equivalent mutant: excluded.
        if ((out.fired.get(t) ?? 0) === 0 && out.ok.get(t) === true) {
          equivalent += 1;
          continue;
        }
        results.push({ spec: specString(spec), test: t, killed: out.ok.get(t) === false });
      }
    }
    for (const { spec, tests } of plan.robustness.values()) {
      const run = tests.filter(healthy);
      if (run.length === 0) continue;
      const out = await runWith(run, spec);
      for (const t of run) if (out.ok.get(t) === false) fragile.push({ spec: specString(spec), test: t });
    }
  } finally {
    await target?.stop();
  }

  const killed = results.filter((r) => r.killed).length;
  const byKind: MutationReport['byKind'] = {};
  for (const r of results) {
    const k = (byKind[r.spec.split(':')[0] ?? '?'] ??= { killed: 0, survived: 0 });
    if (r.killed) k.killed += 1;
    else k.survived += 1;
  }
  const tests = [...new Set(results.map((r) => r.test))];
  const report: MutationReport = {
    runId,
    app: config.id,
    mutants: results.length,
    equivalent,
    killed,
    survived: results.length - killed,
    killRate: results.length === 0 ? 0 : killed / results.length,
    byKind,
    weakTests: tests.filter((t) => !results.some((r) => r.test === t && r.killed)).sort(),
    fragile,
    survivors: results.filter((r) => !r.killed),
    baselineFailures,
    durationMs: Date.now() - started,
  };
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const reportPath = join(workspaceDir(opts.stateRoot, config.id, 'mutation'), `report-${runId}.md`);
  writeFileSync(join(workspaceDir(opts.stateRoot, config.id, 'mutation'), `report-${runId}.json`), JSON.stringify(report, null, 2));
  writeFileSync(
    reportPath,
    [
      `# Pramaan mutation check — ${config.id} — ${runId}`,
      '',
      `**Kill rate ${pct(report.killRate)}** (${killed}/${report.mutants} mutants; ${equivalent} equivalent excluded) · ${runs} suite runs · ${(report.durationMs / 60000).toFixed(1)} min · LLM requests 0`,
      '',
      '| Fault | Killed | Survived |',
      '| --- | --- | --- |',
      ...Object.entries(byKind).sort().map(([k, v]) => `| ${k} | ${v.killed} | ${v.survived} |`),
      '',
      `## Weak tests (killed nothing) — ${report.weakTests.length}`,
      '',
      ...report.weakTests.map((t) => `- ${t}`),
      '',
      `## Fragile under delay-2s — ${fragile.length}`,
      '',
      ...fragile.map((f) => `- ${f.test} (${f.spec})`),
      '',
      `## Surviving mutants — ${report.survivors.length}`,
      '',
      ...report.survivors.map((s) => `- \`${s.spec}\` → ${s.test}`),
      '',
    ].join('\n'),
  );
  new Ledger({ root: opts.stateRoot, app: config.id }).append({
    runId,
    type: 'mutation.result',
    actor: 'pramaan:mutate',
    data: { killRate: report.killRate, mutants: report.mutants, killed, weakTests: report.weakTests.length, fragile: fragile.length },
  });
  return {
    exitCode: 0,
    report,
    reportPath,
    summary: [
      `pramaan mutate — app ${config.id} · run ${runId}`,
      `  kill rate ${pct(report.killRate)} (${killed}/${report.mutants}; ${equivalent} equivalent excluded) · weak tests ${report.weakTests.length} · fragile under delay ${fragile.length}${baselineFailures.length > 0 ? ` · ${baselineFailures.length} test(s) failing without faults were skipped` : ''}`,
      `  ${runs} suite runs · ${(report.durationMs / 60000).toFixed(1)} min · LLM requests 0 · report: ${reportPath}`,
      ...(report.weakTests.length > 0 ? ['  needs the lead: weak tests are listed in the report (they catch none of the injected faults)'] : []),
    ].join('\n'),
  };
}

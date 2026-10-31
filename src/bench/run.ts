// `pramaan bench` (§8 M8): seeded-bug recall and precision of the compiled suite.
// A hit = a failing test whose oracle class matches the bug's expected oracle AND whose operations intersect the
// bug's operations. A bug is detected with ≥ 1 hit. Every other failure — and every failure on `none` — is a false alarm.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { newRunId } from '../core/run-id.js';
import { BugCatalog } from '../core/schemas.js';
import { runSuite } from '../codegen/run-suite.js';
import { parseResults, sameFile, type TestOutcome } from '../triage/parse.js';
import { activate, freePort } from './target.js';

export const TestIndex = z.object({
  tests: z.array(
    z.object({ file: z.string(), title: z.string(), tags: z.array(z.string()), oracle: z.string(), operations: z.array(z.string()), reads: z.record(z.string(), z.array(z.string())).default({}) }).loose(),
  ),
});
export type IndexEntry = z.infer<typeof TestIndex>['tests'][number];

export interface Failure {
  file: string;
  title: string;
  oracle: string; // effective: 'implicit' when the implicit oracle failed it, else the index class
  operations: string[];
}
export interface BugRun {
  bug: string;
  category: string;
  expectedOracle: string;
  detected: boolean;
  hits: string[];
  falseAlarms: string[];
  failures: number;
  durationMs: number;
}
export interface BenchReport {
  runId: string;
  app: string;
  runs: BugRun[];
  recall: number;
  recallByCategory: Record<string, { detected: number; total: number }>;
  precision: number;
  precisionByOracle: Record<string, { true: number; false: number; precision: number }>;
  falseAlarmsOnNone: number;
  durationMs: number;
}

const stripQuery = (op: string): string => op.split('?')[0] ?? op;

/** A charter-candidate bug is caught by the confirmed rule its candidate became (bugs.yaml header, spec §5). */
export function oracleMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'charter-candidate' && actual === 'confirmed-rule');
}

export function failuresOf(outcomes: readonly TestOutcome[], index: readonly IndexEntry[]): Failure[] {
  return outcomes
    .filter((o) => !o.ok && o.status !== 'skipped')
    .map((o) => {
      const e = index.find((x) => x.title === o.title && sameFile(x.file, o.file));
      const implicit = o.errors.some((m) => m.includes('implicit oracle'));
      return { file: o.file, title: o.title, oracle: implicit ? 'implicit' : (e?.oracle ?? 'unknown'), operations: (e?.operations ?? []).map(stripQuery) };
    });
}

export function scoreBug(failures: readonly Failure[], bug: { id: string; category: string; expectedOracle: string; operations: string[] } | undefined): Omit<BugRun, 'durationMs'> {
  const ops = new Set((bug?.operations ?? []).map(stripQuery));
  const hits = bug ? failures.filter((f) => oracleMatches(bug.expectedOracle, f.oracle) && f.operations.some((o) => ops.has(o))) : [];
  const falseAlarms = failures.filter((f) => !hits.includes(f));
  return {
    bug: bug?.id ?? 'none',
    category: bug?.category ?? 'none',
    expectedOracle: bug?.expectedOracle ?? '-',
    detected: hits.length > 0,
    hits: hits.map((h) => `${h.file} > ${h.title}`),
    falseAlarms: falseAlarms.map((f) => `${f.file} > ${f.title} [${f.oracle}]`),
    failures: failures.length,
  };
}

export function summarize(runId: string, app: string, runs: BugRun[], perOracle: Map<string, { t: number; f: number }>, durationMs: number): BenchReport {
  const bugs = runs.filter((r) => r.bug !== 'none');
  const byCat: BenchReport['recallByCategory'] = {};
  for (const r of bugs) {
    const c = (byCat[r.category] ??= { detected: 0, total: 0 });
    c.total += 1;
    if (r.detected) c.detected += 1;
  }
  const hits = runs.reduce((n, r) => n + r.hits.length, 0);
  const all = runs.reduce((n, r) => n + r.failures, 0);
  return {
    runId,
    app,
    runs,
    recall: bugs.length === 0 ? 0 : bugs.filter((r) => r.detected).length / bugs.length,
    recallByCategory: byCat,
    precision: all === 0 ? 1 : hits / all,
    precisionByOracle: Object.fromEntries([...perOracle].map(([o, v]) => [o, { true: v.t, false: v.f, precision: v.t + v.f === 0 ? 1 : v.t / (v.t + v.f) }])),
    falseAlarmsOnNone: runs.find((r) => r.bug === 'none')?.failures ?? 0,
    durationMs,
  };
}

export function renderBench(r: BenchReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  return [
    `# Pramaan bench — ${r.app} — ${r.runId}`,
    '',
    `**Recall ${pct(r.recall)}** (${r.runs.filter((x) => x.bug !== 'none' && x.detected).length}/${r.runs.filter((x) => x.bug !== 'none').length} seeded bugs) · **precision of failures ${pct(r.precision)}** · false alarms on \`none\`: **${r.falseAlarmsOnNone}** · ${(r.durationMs / 60000).toFixed(1)} min · LLM requests 0`,
    '',
    '| Category | Detected |',
    '| --- | --- |',
    ...Object.entries(r.recallByCategory).map(([c, v]) => `| ${c} | ${v.detected}/${v.total} |`),
    '',
    '| Oracle | True failures | False alarms | Precision |',
    '| --- | --- | --- | --- |',
    ...Object.entries(r.precisionByOracle).map(([o, v]) => `| ${o} | ${v.true} | ${v.false} | ${pct(v.precision)} |`),
    '',
    '| Bug | Expected oracle | Detected | Hits | False alarms |',
    '| --- | --- | --- | --- | --- |',
    ...r.runs.map((x) => `| ${x.bug} | ${x.expectedOracle} | ${x.bug === 'none' ? '—' : x.detected ? 'yes' : '**no**'} | ${x.hits.length} | ${x.falseAlarms.length} |`),
    '',
    ...r.runs.filter((x) => x.falseAlarms.length > 0).flatMap((x) => [`## False alarms with ${x.bug}`, '', ...x.falseAlarms.map((f) => `- ${f}`), '']),
  ].join('\n');
}

export interface BenchOptions {
  appId: string;
  stateRoot: string;
  bugs: 'all' | string[];
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
  ask?: (message: string) => Promise<void>;
}

export async function runBench(opts: BenchOptions): Promise<{ exitCode: 0 | 2; report?: BenchReport; reportPath?: string; summary: string }> {
  const root = repoRoot();
  const { config } = loadAppConfig(opts.appId, opts.env ? { root, env: opts.env } : { root });
  const catalogPath = join(root, 'benchmark', config.id, 'bugs.yaml');
  const repo = opts.repoPath ?? (isAbsolute(config.output.repoPath) ? config.output.repoPath : resolve(root, config.output.repoPath));
  const indexPath = join(repo, 'spec', 'test-index.json');
  if (!existsSync(catalogPath)) return { exitCode: 2, summary: `pramaan bench — no bug catalog at ${catalogPath}` };
  if (!existsSync(indexPath)) return { exitCode: 2, summary: `pramaan bench — no compiled suite at ${repo}: run \`pramaan compile\` first` };
  const catalog = BugCatalog.parse(parseYaml(readFileSync(catalogPath, 'utf8'))).bugs;
  const bugs = opts.bugs === 'all' ? catalog.filter((b) => b.mvp) : catalog.filter((b) => (opts.bugs as string[]).includes(b.id));
  const index = TestIndex.parse(JSON.parse(readFileSync(indexPath, 'utf8'))).tests;
  const runId = newRunId();
  const started = Date.now();
  const port = await freePort();
  const runs: BugRun[] = [];
  const perOracle = new Map<string, { t: number; f: number }>();
  const plan = [{ id: 'none', activation: { env: { DEMO_BUGS: 'none' } } as const, bug: undefined }, ...bugs.map((b) => ({ id: b.id, activation: b.activation, bug: b }))];

  for (const [i, step] of plan.entries()) {
    const t0 = Date.now();
    const target = await activate(config.id, step.activation, { port, ...(opts.ask ? { ask: opts.ask } : {}) });
    try {
      const res = await runSuite({
        appId: opts.appId,
        stateRoot: opts.stateRoot,
        repoPath: repo,
        suite: 'all',
        env: { ...(opts.env ?? process.env), DEMO_PORT: String(port), ...(i > 0 ? { PRAMAAN_REUSE_AUTH: '1' } : {}) },
      });
      const failures = res.resultsPath ? failuresOf(parseResults(res.resultsPath), index) : [];
      const scored = scoreBug(failures, step.bug);
      for (const f of failures) {
        const v = perOracle.get(f.oracle) ?? { t: 0, f: 0 };
        if (scored.hits.includes(`${f.file} > ${f.title}`)) v.t += 1;
        else v.f += 1;
        perOracle.set(f.oracle, v);
      }
      runs.push({ ...scored, durationMs: Date.now() - t0 });
    } finally {
      await target.stop();
    }
  }

  const report = summarize(runId, config.id, runs, perOracle, Date.now() - started);
  const dir = workspaceDir(opts.stateRoot, config.id, 'bench');
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `report-${runId}.md`);
  writeFileSync(reportPath, renderBench(report));
  writeFileSync(join(dir, `report-${runId}.json`), JSON.stringify(report, null, 2));
  new Ledger({ root: opts.stateRoot, app: config.id }).append({
    runId,
    type: 'bench.result',
    actor: 'pramaan:bench',
    data: { recall: report.recall, precision: report.precision, falseAlarmsOnNone: report.falseAlarmsOnNone, bugs: bugs.length, detected: runs.filter((r) => r.bug !== 'none' && r.detected).map((r) => r.bug) },
  });
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  return {
    exitCode: 0,
    report,
    reportPath,
    summary: [
      `pramaan bench — app ${config.id} · run ${runId}`,
      `  recall ${pct(report.recall)} (${runs.filter((r) => r.bug !== 'none' && r.detected).length}/${bugs.length}) · precision of failures ${pct(report.precision)} · false alarms on none ${report.falseAlarmsOnNone}`,
      ...runs.filter((r) => r.bug !== 'none' && !r.detected).map((r) => `  missed: ${r.bug} (${r.category}, expects ${r.expectedOracle})`),
      `  ${(report.durationMs / 60000).toFixed(1)} min · LLM requests 0 · report: ${reportPath}`,
    ].join('\n'),
  };
}

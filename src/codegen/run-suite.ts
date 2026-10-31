// `pramaan run` (§8 M6): runs the suite repo (no LLM), copies results.json into the workspace.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { newRunId } from '../core/run-id.js';
import { networkAllowed } from '../onboarding/contract.js';
import { runAsync } from './writer.js';

export interface RunOptions {
  appId: string;
  stateRoot: string;
  suite?: 'smoke' | 'regression' | 'authz' | 'all';
  target?: 'staging' | undefined;
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}
export interface RunResult {
  runId: string;
  exitCode: number;
  resultsPath?: string;
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  output: string;
  summary: string;
}

const Results = z.object({ stats: z.object({ expected: z.number(), unexpected: z.number(), flaky: z.number(), skipped: z.number() }).loose() }).loose();

export async function runSuite(opts: RunOptions): Promise<RunResult> {
  const root = repoRoot();
  const loaded = loadAppConfig(opts.appId, opts.env ? { root, env: opts.env } : { root });
  const { config, env } = loaded;
  const runId = newRunId();
  const empty = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  if (!networkAllowed(loaded, opts.target)) {
    return { runId, exitCode: 2, stats: empty, output: '', summary: `pramaan run — no network calls made: ${config.id} needs --target staging` };
  }
  const repo = opts.repoPath ?? (isAbsolute(config.output.repoPath) ? config.output.repoPath : resolve(root, config.output.repoPath));
  const suite = opts.suite ?? 'regression';
  // Pramaan hands the suite only what a CI job would have: URLs, the run id and the role logins.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, BASE_URL: config.baseUrl, PRAMAAN_RUN_ID: runId };
  if (config.apiBaseUrl) childEnv['API_ORIGIN'] = new URL(config.apiBaseUrl).origin;
  const args = ['playwright', 'test', ...(suite === 'all' ? [] : ['--grep', `@${suite}`]), ...(opts.extraArgs ?? [])];
  const r = await runAsync('npx', args, repo, childEnv);

  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  const src = join(repo, 'results.json');
  let stats = empty;
  let resultsPath: string | undefined;
  if (existsSync(src)) {
    const dir = workspaceDir(opts.stateRoot, config.id, 'runs', runId);
    mkdirSync(dir, { recursive: true });
    resultsPath = join(dir, 'results.json');
    copyFileSync(src, resultsPath);
    stats = Results.parse(JSON.parse(readFileSync(src, 'utf8'))).stats;
  }
  ledger.append({ runId, type: 'run.completed', actor: 'pramaan:run', data: { command: 'run', suite, ...stats, exitCode: r.status } });
  const summary = [
    `pramaan run — app ${config.id} · suite ${suite} · run ${runId}`,
    `  passed ${stats.expected} · failed ${stats.unexpected} · flaky ${stats.flaky} · skipped ${stats.skipped}`,
    `  LLM requests: 0 · results: ${resultsPath ?? '(none written)'}`,
    ...(stats.unexpected > 0 ? [`  next: pramaan triage --results "${resultsPath ?? ''}" (M9)`] : []),
  ].join('\n');
  return { runId, exitCode: r.status, ...(resultsPath ? { resultsPath } : {}), stats, output: r.out, summary };
}

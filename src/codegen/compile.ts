// `pramaan compile` (§8 M6): Living Spec + confirmed decisions → the suite repo, then its own typecheck and lint.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { loadMatrix } from '../authz/matrix-io.js';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { newRunId } from '../core/run-id.js';
import { Candidate, FormInfo, TextElement } from '../crawler/candidates.js';
import { normalizeRoute } from '../crawler/state-key.js';
import { resolveTeardown, type TeardownPlan } from '../data/orphans.js';
import { loadSession } from '../onboarding/sessions.js';
import { loadAssertions } from '../spec/assertion-proposer.js';
import { bindEntity } from '../spec/domain-pack.js';
import { EntitiesFile } from '../spec/entities.js';
import { buildApiModel } from '../spec/har-to-openapi.js';
import { collectObservations } from '../spec/infer.js';
import { loadRules } from '../spec/rule-proposer.js';
import { parse as parseYaml } from 'yaml';
import { generateSuite, type CrawlState } from './generate.js';
import { commitSuite, run, writeSuite } from './writer.js';

export interface CompileOptions {
  appId: string;
  stateRoot: string;
  /** Overrides app.yaml output.repoPath (tests use a temp dir). */
  repoPath?: string;
  /** npm install in the suite when dependencies changed (default true). */
  install?: boolean;
  env?: NodeJS.ProcessEnv;
}
export interface CompileResult {
  runId: string;
  exitCode: 0 | 1 | 2;
  repoPath: string;
  branch?: string;
  written: number;
  handEdited: string[];
  tests: number;
  skipped: { what: string; reason: string }[];
  checks: { typecheck: boolean; lint: boolean; output: string };
  summary: string;
}

const CrawlSummary = z.object({ learnedTeardown: z.record(z.string(), z.string()).default({}) }).loose();
const ACTOR = 'pramaan:compile';

function crawlStates(crawlDir: string): CrawlState[] {
  if (!existsSync(crawlDir)) return [];
  const out: CrawlState[] = [];
  for (const role of readdirSync(crawlDir).sort()) {
    const dir = join(crawlDir, role, 'states');
    if (!existsSync(dir)) continue;
    for (const key of readdirSync(dir).sort()) {
      const d = join(dir, key);
      try {
        const url = readFileSync(join(d, 'url.txt'), 'utf8');
        out.push({
          role,
          route: normalizeRoute(url),
          url,
          candidates: z.array(Candidate.loose()).parse(JSON.parse(readFileSync(join(d, 'candidates.json'), 'utf8'))),
          forms: z.array(FormInfo).parse(JSON.parse(readFileSync(join(d, 'forms.json'), 'utf8'))),
          texts: existsSync(join(d, 'texts.json')) ? z.array(TextElement).parse(JSON.parse(readFileSync(join(d, 'texts.json'), 'utf8'))) : [],
        });
      } catch {
        // incomplete capture
      }
    }
  }
  return out;
}

export async function runCompile(opts: CompileOptions): Promise<CompileResult> {
  const root = repoRoot();
  const { config } = loadAppConfig(opts.appId, opts.env ? { root, env: opts.env } : { root });
  const runId = newRunId();
  const repo = opts.repoPath ?? (isAbsolute(config.output.repoPath) ? config.output.repoPath : resolve(root, config.output.repoPath));
  const specDir = workspaceDir(opts.stateRoot, config.id, 'spec');
  const fail = (summary: string): CompileResult => ({
    runId, exitCode: 2, repoPath: repo, written: 0, handEdited: [], tests: 0, skipped: [], checks: { typecheck: false, lint: false, output: '' }, summary,
  });
  if (!existsSync(join(specDir, 'entities.yaml'))) return fail(`pramaan compile — app ${config.id}\n  no Living Spec yet: run crawl and infer first`);

  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  const events = ledger.read();
  ledger.append({ runId, type: 'run.started', actor: ACTOR, data: { command: 'compile' } });

  const { observations } = collectObservations(opts.stateRoot, config);
  const model = buildApiModel(observations);
  const entities = EntitiesFile.parse(parseYaml(readFileSync(join(specDir, 'entities.yaml'), 'utf8'))).entities;
  const roles = config.roles.map((r) => ({ role: r.id, tenant: r.tenant }));
  const bindings = entities.flatMap((e) => {
    const b = e.createOp ? bindEntity(e, model, roles, config.safety.runTagPrefix) : undefined;
    return b ? [b] : [];
  });
  const summaryPath = workspaceDir(opts.stateRoot, config.id, 'crawl', 'crawl-summary.json');
  const learned = existsSync(summaryPath) ? CrawlSummary.parse(JSON.parse(readFileSync(summaryPath, 'utf8'))).learnedTeardown : {};
  const teardownOps = new Map<string, TeardownPlan>();
  for (const e of entities) {
    const plan = resolveTeardown(e, learned[e.name]);
    if (plan) teardownOps.set(e.name, plan);
  }
  const session = config.roles.map((r) => loadSession(opts.stateRoot, config.id, r.id)).find((s) => s !== undefined);
  const specTexts: Record<string, string> = {};
  for (const name of ['openapi.observed.yaml', 'entities.yaml', 'rules.yaml', 'role-matrix.yaml']) {
    if (existsSync(join(specDir, name))) specTexts[name] = readFileSync(join(specDir, name), 'utf8');
  }

  const gen = generateSuite({
    config,
    model,
    entities,
    bindings,
    matrix: loadMatrix(join(specDir, 'role-matrix.yaml')),
    rules: loadRules(join(specDir, 'rules.yaml')),
    assertions: loadAssertions(join(specDir, 'assertions')),
    states: crawlStates(workspaceDir(opts.stateRoot, config.id, 'crawl')),
    authScheme: session?.meta.scheme,
    teardownOps,
    ledgerEvents: events,
    specTexts,
    jsonpathSource: readFileSync(join(root, 'src', 'dsl', 'jsonpath.ts'), 'utf8'),
  });

  const { mkdirSync } = await import('node:fs');
  mkdirSync(repo, { recursive: true });
  const w = writeSuite(repo, gen.files);

  // Dependencies: install when package.json changed or node_modules is missing (writes package-lock.json).
  let output = '';
  if (opts.install !== false && (w.written.includes('package.json') || !existsSync(join(repo, 'node_modules')))) {
    const i = run('npm', ['install', '--no-audit', '--no-fund'], repo);
    output += i.out;
    if (i.status !== 0) return { ...fail(`pramaan compile — npm install failed in ${repo}\n${i.out.slice(-2000)}`), exitCode: 1 };
  }
  const tsc = run('npx', ['tsc', '--noEmit'], repo);
  const lint = run('npx', ['eslint', '.'], repo);
  output += tsc.out + lint.out;
  const ok = tsc.status === 0 && lint.status === 0;
  const commit = ok ? commitSuite(repo, runId, `feat(suite): compile ${runId} — ${gen.index.length} tests\n\nGenerated by Pramaan ${'0.1.0'} (no LLM calls).`) : { changed: false };
  ledger.append({ runId, type: 'run.completed', actor: ACTOR, data: { command: 'compile', ok, tests: gen.index.length, written: w.written.length } });

  const count = (o: string): number => gen.index.filter((t) => t.oracle === o).length;
  const summary = [
    `pramaan compile — app ${config.id} · run ${runId}`,
    `  suite: ${repo}${'branch' in commit && commit.branch ? ` · branch ${commit.branch} (${commit.commit ?? ''})` : ' · no changes to commit'}`,
    `  tests ${gen.index.length}: rules ${count('confirmed-rule')} · authz ${count('authz-matrix')} · consistency ${count('consistency')} · smoke ${count('implicit')}`,
    `  files: ${w.written.length} written · ${w.unchanged.length} unchanged · ${w.handEdited.length} hand-edited (kept) · ${w.removed.length} removed`,
    ...gen.skipped.map((s) => `  not compiled: ${s.what} — ${s.reason}`),
    `  suite typecheck ${tsc.status === 0 ? 'ok' : 'FAILED'} · suite lint ${lint.status === 0 ? 'ok' : 'FAILED'}`,
    ...(ok ? [] : [output.slice(-3000)]),
    '  LLM requests: 0 · the suite has no LLM dependency',
    ...(ok && 'branch' in commit && commit.branch ? [`  needs the lead: review branch ${commit.branch} (or open it as a PR)`] : []),
  ].join('\n');
  return {
    runId,
    exitCode: ok ? 0 : 1,
    repoPath: repo,
    ...('branch' in commit && commit.branch ? { branch: commit.branch } : {}),
    written: w.written.length,
    handEdited: w.handEdited,
    tests: gen.index.length,
    skipped: gen.skipped,
    checks: { typecheck: tsc.status === 0, lint: lint.status === 0, output },
    summary,
  };
}

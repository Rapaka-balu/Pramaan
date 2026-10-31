// `pramaan triage --results <path|dir>` (§8 M9): failures → signature → isolated reruns → class → action.
// flaky → quarantine; locator-drift → heal (pages/ only, lint-gated); environment → alert; spec-change and
// product bugs → findings (auto-filed only when the oracle class has earned it, §4.7).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { TestIndex, type IndexEntry } from '../bench/run.js';
import { crawlStates } from '../codegen/compile.js';
import { runSuite } from '../codegen/run-suite.js';
import { run } from '../codegen/writer.js';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { redactText } from '../core/redact.js';
import { newRunId } from '../core/run-id.js';
import { Finding } from '../core/schemas.js';
import { LlmClient } from '../llm/client.js';
import { loadPrompt } from '../llm/prompts.js';
import { lintChanges } from '../maintain/expect-lint.js';
import { planHeal } from '../maintain/heal.js';
import { titlesRegex } from '../mutation/faults.js';
import { ev } from '../spec/domain-pack.js';
import { classifyFailure, type FailureClass } from './classify.js';
import { parseResults, sameFile, type TestOutcome } from './parse.js';
import { mayAutoFile, precisionByOracle } from './precision.js';
import { signature } from './signature.js';

export const Quarantine = z.object({
  tests: z.array(z.object({ id: z.string(), file: z.string(), title: z.string(), signature: z.string(), since: z.string() })),
});
type FindingT = z.infer<typeof Finding>;

export interface TriageItem {
  testId: string;
  title: string;
  cls: FailureClass;
  reason: string;
  signature: string;
  action: string;
  findingId?: string;
}
export interface TriageResult {
  runId: string;
  exitCode: 0 | 1 | 2;
  items: TriageItem[];
  reportPath?: string;
  summary: string;
}
export interface TriageOptions {
  appId: string;
  stateRoot: string;
  results: string;
  repoPath?: string;
  target?: 'staging' | undefined;
  rerun?: boolean;
  heal?: boolean;
  env?: NodeJS.ProcessEnv;
}

const ACTOR = 'pramaan:triage';

function resultFiles(p: string): string[] {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { recursive: true, encoding: 'utf8' })
    .filter((f) => /results.*\.json$/.test(basename(f)))
    .map((f) => join(p, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/** The expect message, expected and received lines: what a human needs first (deterministic fallback summary). */
function plainSummary(errors: string[]): string {
  const e = errors[0] ?? '';
  const lines = e.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] ?? 'failed';
  const exp = lines.find((l) => l.startsWith('Expected'));
  const rec = lines.find((l) => l.startsWith('Received'));
  return [head, exp, rec].filter(Boolean).join('\n');
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  const root = repoRoot();
  const { config } = loadAppConfig(opts.appId, opts.env ? { root, env: opts.env } : { root });
  const runId = newRunId();
  const repo = opts.repoPath ?? (isAbsolute(config.output.repoPath) ? config.output.repoPath : resolve(root, config.output.repoPath));
  const files = resultFiles(opts.results);
  const head = `pramaan triage — app ${config.id} · run ${runId}`;
  if (files.length === 0) return { runId, exitCode: 2, items: [], summary: `${head}\n  no results.json at ${opts.results}` };
  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  const triageDir = workspaceDir(opts.stateRoot, config.id, 'triage', runId);
  mkdirSync(triageDir, { recursive: true });
  // Imported CI artifacts are kept: flake statistics are computed from them.
  files.forEach((f, i) => copyFileSync(f, join(triageDir, `imported-${i}-${basename(f)}`)));

  const index: IndexEntry[] = existsSync(join(repo, 'spec', 'test-index.json')) ? TestIndex.parse(JSON.parse(readFileSync(join(repo, 'spec', 'test-index.json'), 'utf8'))).tests : [];
  const openapi = existsSync(join(repo, 'spec', 'openapi.observed.yaml')) ? (parseYaml(readFileSync(join(repo, 'spec', 'openapi.observed.yaml'), 'utf8')) as { paths?: Record<string, Record<string, unknown>> }) : {};
  const knownOps = new Set(Object.entries(openapi.paths ?? {}).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)));
  const qPath = join(repo, 'quarantine.json');
  const quarantine = existsSync(qPath) ? Quarantine.parse(JSON.parse(readFileSync(qPath, 'utf8'))) : { tests: [] };

  const outcomes: TestOutcome[] = parseResults(files[files.length - 1] ?? '');
  const ran = outcomes.filter((o) => o.status !== 'skipped');
  const failed = ran.filter((o) => !o.ok);
  const massFailure = ran.length > 0 && failed.length / ran.length > 0.5;
  const entryOf = (o: TestOutcome): IndexEntry | undefined => index.find((e) => e.title === o.title && sameFile(e.file, o.file));
  const testId = (o: TestOutcome): string => `${o.file} > ${o.title}`;

  // Isolated reruns: --repeat-each=3 --workers=1, quarantined tests included.
  const rerun = new Map<string, TestOutcome>();
  if (opts.rerun !== false && failed.length > 0 && !massFailure) {
    const grep = join(triageDir, 'rerun-grep.txt');
    writeFileSync(grep, titlesRegex(failed.map((f) => f.title)));
    const res = await runSuite({
      appId: opts.appId,
      stateRoot: opts.stateRoot,
      repoPath: repo,
      suite: 'all',
      target: opts.target,
      extraArgs: ['--repeat-each=3', '--workers=1'],
      env: { ...(opts.env ?? process.env), PRAMAAN_GREP_FILE: grep, PRAMAAN_INCLUDE_QUARANTINED: '1', PRAMAAN_REUSE_AUTH: '1' },
    });
    if (res.resultsPath) for (const o of parseResults(res.resultsPath)) rerun.set(o.title, o);
  }

  const events = ledger.read();
  const llm = new LlmClient({ appId: config.id, root, onCall: (r) => ledger.append({ runId, type: 'llm.call', actor: ACTOR, data: { ...r } }) });
  const prompt = loadPrompt('triage-summary');
  const findingsDir = workspaceDir(opts.stateRoot, config.id, 'findings');
  const defectsDir = workspaceDir(opts.stateRoot, config.id, 'defects');
  mkdirSync(findingsDir, { recursive: true });
  mkdirSync(defectsDir, { recursive: true });
  const existing: FindingT[] = readdirSync(findingsDir).filter((f) => /^F-\d{4,}\.json$/.test(f)).map((f) => Finding.parse(JSON.parse(readFileSync(join(findingsDir, f), 'utf8'))));
  let nextId = existing.reduce((n, f) => Math.max(n, Number(f.id.slice(2))), 0) + 1;
  const items: TriageItem[] = [];
  let quarantineChanged = false;
  let healChanged = false;

  for (const o of failed) {
    const id = testId(o);
    const entry = entryOf(o);
    const sig = signature({ testId: id, message: o.errors[0] ?? '', ...(o.steps[0] ? { step: o.steps[0] } : {}) });
    const r = rerun.get(o.title);
    const { cls, reason } = classifyFailure({
      testId: id,
      signature: sig,
      errors: o.errors,
      ...(r ? { rerun: { runs: r.runs, passes: r.passes, errors: r.errors } } : {}),
      operations: entry?.operations ?? [],
      knownOps,
      quarantinedSignatures: new Set(quarantine.tests.map((t) => t.signature)),
      massFailure,
    });
    const item: TriageItem = { testId: id, title: o.title, cls, reason, signature: sig, action: '' };

    if (cls === 'flaky') {
      if (!quarantine.tests.some((t) => t.id === id)) {
        quarantine.tests.push({ id, file: o.file, title: o.title, signature: sig, since: runId });
        quarantineChanged = true;
      }
      ledger.append({ runId, type: 'test.quarantined', actor: ACTOR, data: { testId: id, signature: sig, reason } });
      item.action = 'quarantined (never filed)';
    } else if (cls === 'flaky-known') {
      item.action = 'already quarantined';
    } else if (cls === 'environment') {
      item.action = 'alert only — no bug filed';
    } else if (cls === 'locator-drift') {
      item.action = opts.heal === false ? 'heal skipped (--no-heal)' : await heal(o);
    } else {
      // spec-change and product-bug-candidate → a finding
      const implicit = o.errors.some((m) => m.includes('implicit oracle'));
      const oracle = (implicit ? 'implicit' : (entry?.oracle ?? 'confirmed-rule')) as FindingT['oracle'];
      const prior = existing.find((f) => f.signature === sig);
      let finding: FindingT;
      if (prior) {
        finding = { ...prior, lastSeenRunId: runId };
      } else {
        const gate = cls === 'product-bug-candidate' ? mayAutoFile(oracle, events, config.lead) : { ok: false, reason: 'spec changes always go to the lead' };
        const summaryRes = await llm.structured({
          purpose: 'triage-summary',
          tier: 'mid',
          system: prompt.body,
          user: `Test: ${o.title}\nOracle: ${oracle}\nFailure:\n${redactText(o.errors.join('\n').slice(0, 3000))}`,
          schema: z.object({ summary: z.string().max(400) }),
          schemaName: 'triage_summary',
          promptVersion: prompt.version,
          fallback: () => ({ summary: plainSummary(o.errors) }),
        });
        finding = {
          id: `F-${String(nextId++).padStart(4, '0')}`,
          title: `${cls === 'spec-change' ? 'Spec change: ' : ''}${o.title} fails — ${(o.errors[0] ?? 'failed').split('\n')[0]?.slice(0, 140) ?? ''}`,
          severity: cls === 'spec-change' ? 'S3' : oracle === 'authz-matrix' ? 'S1' : 'S2',
          oracle,
          ...(entry?.ruleIds[0] ? { ruleId: entry.ruleIds[0] } : {}),
          testId: id,
          signature: sig,
          evidence: [
            { ...ev('replay', `${basename(files[files.length - 1] ?? '')}#${o.title}`), excerpt: redactText(plainSummary(o.errors)).slice(0, 600) },
            ...o.attachments.filter((a) => /\.(png|zip)$/.test(a)).slice(0, 2).map((a) => ev(a.endsWith('.png') ? 'screenshot' : 'replay', a)),
          ],
          reproSteps: [`cd ${repo}`, `npx playwright test --grep "${o.title}"`, 'See the trace attachment for the exact requests.'],
          status: gate.ok ? 'auto-filed' : 'queued',
          firstSeenRunId: runId,
          lastSeenRunId: runId,
        };
        ledger.append({ runId, type: 'finding.created', actor: ACTOR, data: { findingId: finding.id, oracle, cls } });
        ledger.append({ runId, type: gate.ok ? 'finding.autofiled' : 'finding.queued', actor: ACTOR, data: { findingId: finding.id, gate: gate.reason } });
        const p = precisionByOracle(events).get(oracle);
        writeFileSync(
          join(defectsDir, `${finding.id}.md`),
          [
            `# ${finding.id} · ${finding.severity} · ${finding.title}`,
            '',
            `**Status:** ${finding.status} (${gate.reason}) · **Oracle:** ${oracle}, precision ${p ? `${(p.precision * 100).toFixed(0)}% over ${p.verdicts} verdicts` : 'no verdicts yet'}`,
            '',
            '## Summary',
            '',
            summaryRes.value.summary,
            '',
            '## Repro',
            '',
            ...finding.reproSteps.map((s, i) => `${i + 1}. \`${s}\``),
            '',
            '## Evidence',
            '',
            ...finding.evidence.map((e) => `- ${e.kind}: \`${e.ref}\``),
            ...(r ? ['', `Reruns: failed ${r.runs - r.passes}/${r.runs} in isolation.`] : []),
            '',
          ].join('\n'),
        );
      }
      writeFileSync(join(findingsDir, `${finding.id}.json`), JSON.stringify(finding, null, 2));
      item.findingId = finding.id;
      item.action = prior ? `seen again (${finding.id})` : `${finding.status} as ${finding.id}`;
    }
    items.push(item);
  }

  if (quarantineChanged) {
    writeFileSync(qPath, `${JSON.stringify(quarantine, null, 2)}\n`);
  }
  if (quarantineChanged || healChanged) commitSuiteChange(repo, runId, items);

  const by = (c: FailureClass): number => items.filter((i) => i.cls === c).length;
  const reportPath = join(triageDir, `TRIAGE-${runId}.md`);
  writeFileSync(
    reportPath,
    [`# Triage ${runId}`, '', '| Test | Class | Why | Action |', '| --- | --- | --- | --- |', ...items.map((i) => `| ${i.title} | ${i.cls} | ${i.reason} | ${i.action} |`), ''].join('\n'),
  );
  return {
    runId,
    exitCode: items.some((i) => i.cls === 'product-bug-candidate') ? 1 : 0,
    items,
    reportPath,
    summary: [
      head,
      `  ${failed.length} failure(s) in ${ran.length} tests${massFailure ? ' — more than half failed: environment' : ''}`,
      `  product bugs ${by('product-bug-candidate')} · spec changes ${by('spec-change')} · flaky ${by('flaky')} (+${by('flaky-known')} known) · locator drift ${by('locator-drift')} · environment ${by('environment')}`,
      ...items.map((i) => `  ${i.cls.padEnd(22)} ${i.title.slice(0, 70)} → ${i.action}`),
      `  report: ${reportPath}`,
    ].join('\n'),
  };

  async function heal(o: TestOutcome): Promise<string> {
    const plan = await planHeal({
      repo,
      error: [...o.errors, ...(rerun.get(o.title)?.errors ?? [])].join('\n'),
      config,
      stateRoot: opts.stateRoot,
      states: crawlStates(workspaceDir(opts.stateRoot, config.id, 'crawl')),
      baseUrl: config.baseUrl,
    });
    if ('reason' in plan) {
      ledger.append({ runId, type: 'heal.rejected', actor: ACTOR, data: { testId: testId(o), reason: plan.reason } });
      return `heal rejected: ${plan.reason} (queued for the lead)`;
    }
    const file = join(repo, plan.getter.file);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, plan.newSource);
    const lint = lintChanges([{ file: plan.getter.file, base: original, head: plan.newSource }], { healPr: true });
    const grep = join(triageDir, `heal-${plan.getter.getter}.txt`);
    writeFileSync(grep, titlesRegex([o.title]));
    const check = lint.length === 0
      ? await runSuite({ appId: opts.appId, stateRoot: opts.stateRoot, repoPath: repo, suite: 'all', target: opts.target, env: { ...(opts.env ?? process.env), PRAMAAN_GREP_FILE: grep, PRAMAAN_INCLUDE_QUARANTINED: '1', PRAMAAN_REUSE_AUTH: '1' } })
      : undefined;
    if (!check || check.stats.unexpected > 0 || check.stats.expected === 0) {
      writeFileSync(file, original);
      const reason = lint.length > 0 ? `heal lint: ${lint.join('; ')}` : 'the test still fails with the new locator';
      ledger.append({ runId, type: 'heal.rejected', actor: ACTOR, data: { testId: testId(o), reason, before: plan.before, after: plan.after } });
      return `heal rejected: ${reason}`;
    }
    healChanged = true;
    ledger.append({ runId, type: 'heal.applied', actor: ACTOR, data: { testId: testId(o), file: plan.getter.file, getter: plan.getter.getter, before: plan.before, after: plan.after, why: plan.why } });
    return `healed ${plan.getter.file} ${plan.getter.getter}(): ${plan.before} → ${plan.after} (${plan.why}); test passes, lint ok`;
  }
}

/** Quarantine and heal changes go on their own branch (heal PRs touch pages/ only; the lint has checked that). */
function commitSuiteChange(repo: string, runId: string, items: TriageItem[]): void {
  if (!existsSync(join(repo, '.git'))) return;
  const id = ['-c', 'user.name=Pramaan', '-c', 'user.email=pramaan@localhost', '-c', 'commit.gpgsign=false'];
  const healed = items.filter((i) => i.action.startsWith('healed')).length;
  const quarantined = items.filter((i) => i.cls === 'flaky').length;
  run('git', ['checkout', '-q', '-b', `pramaan/${healed > 0 ? 'heal' : 'quarantine'}-${runId}`], repo);
  run('git', ['add', '-A', ...['pages', 'quarantine.json'].filter((p) => existsSync(join(repo, p)))], repo);
  run('git', [...id, 'commit', '-q', '-m', `fix(suite): triage ${runId} — ${healed} locator heal(s), ${quarantined} quarantined\n\nGenerated by Pramaan triage (no LLM decisions).`], repo);
}

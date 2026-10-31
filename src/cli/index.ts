#!/usr/bin/env node
// Pramaan CLI. One subcommand per pipeline stage (§3.4).
import { Command, Option } from 'commander';
import { repoRoot } from '../core/config.js';
import { stateRoot } from '../core/paths.js';
import { runAuthz } from '../authz/run.js';
import { runBench } from '../bench/run.js';
import { runCompile } from '../codegen/compile.js';
import { runMutate } from '../mutation/runner.js';
import { runSuite } from '../codegen/run-suite.js';
import { runCrawl } from '../crawler/crawl.js';
import { runOrphans, runSeed, runTeardown } from '../data/commands.js';
import { runOnboard } from '../onboarding/onboard.js';
import { exportReview, importReview, inquirerPrompter, queueSummary, runInteractiveReview } from '../lead/review.js';
import { runInfer } from '../spec/infer.js';
import { runTriage } from '../triage/run.js';
import { formatDoctor, runDoctor } from './doctor.js';

const program = new Command();
program.name('pramaan').description('Autonomous multi-agent QA — agents author, deterministic code judges.');

// There is deliberately no 'production' choice (§2.3 #8).
const targetOption = (): Option => new Option('--target <target>', 'explicit target environment').choices(['staging']);

program
  .command('doctor')
  .description('check Node, browsers, env keys, target reachability and LLM mode')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .action(async (opts: { app: string; target?: 'staging' }) => {
    const report = await runDoctor({ appId: opts.app, root: repoRoot(), target: opts.target });
    console.log(formatDoctor(report));
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command('onboard')
  .description('contract check, log in as every role, save sessions and derive API auth')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .option('--role <ids>', 'comma-separated subset of roles')
  .action(async (opts: { app: string; target?: 'staging'; role?: string }) => {
    const res = await runOnboard({
      appId: opts.app,
      stateRoot: stateRoot(),
      target: opts.target,
      roles: opts.role?.split(',').map((s) => s.trim()),
    });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('crawl')
  .description('BFS-crawl the app as each role (HAR + state snapshots), then tear down created records')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .option('--role <ids>', 'comma-separated subset of roles')
  .option('--max-states <n>', 'override crawl.maxStatesPerRole', (v) => Number.parseInt(v, 10))
  .action(async (opts: { app: string; target?: 'staging'; role?: string; maxStates?: number }) => {
    const res = await runCrawl({
      appId: opts.app,
      stateRoot: stateRoot(),
      target: opts.target,
      roles: opts.role?.split(',').map((s) => s.trim()),
      maxStates: opts.maxStates,
    });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('infer')
  .description('observed OpenAPI, entities and state machines from the crawl; lifecycle probe confirms transitions')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .option('--no-probe', 'skip the lifecycle probe (no network calls)')
  .action(async (opts: { app: string; target?: 'staging'; probe: boolean }) => {
    const res = await runInfer({ appId: opts.app, stateRoot: stateRoot(), target: opts.target, probe: opts.probe });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('authz')
  .description('differential authorization replay; updates the observed side of the role matrix')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .action(async (opts: { app: string; target?: 'staging' }) => {
    const res = await runAuthz({ appId: opts.app, stateRoot: stateRoot(), target: opts.target });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('review')
  .description('the lead queue: rules, matrix rows, assertions, findings and questions (shows the queue by default)')
  .requiredOption('--app <id>', 'app id under apps/')
  .option('--interactive', 'decide items one at a time; your minutes are measured')
  .option('--export', 'write review/REVIEW-<date>.md with checkboxes')
  .option('--import <file>', 'apply a ticked REVIEW-<date>.md')
  .option('--by <name>', 'who is deciding', 'balu')
  .action(async (opts: { app: string; interactive?: boolean; export?: boolean; import?: string; by: string }) => {
    const base = { appId: opts.app, stateRoot: stateRoot(), by: `lead:${opts.by}` };
    if (opts.interactive) {
      const r = await runInteractiveReview(base, inquirerPrompter);
      console.log(`pramaan review — decided ${r.decided} item(s) in ${r.minutes} min (recorded as lead.session)`);
    } else if (opts.export) {
      const r = exportReview(base);
      console.log(`pramaan review — ${r.items} item(s) written to ${r.path}
  tick confirm/reject, then: pramaan review --app ${opts.app} --import "${r.path}"`);
    } else if (opts.import) {
      const r = importReview(base, opts.import);
      console.log(`pramaan review — decided ${r.decided}, skipped ${r.skipped}${r.conflicts.length > 0 ? ` · both boxes ticked (skipped): ${r.conflicts.join(', ')}` : ''}`);
    } else {
      console.log(queueSummary(base));
    }
  });

program
  .command('compile')
  .description('write the suite repo (Playwright + TypeScript, no LLM) from the Living Spec and confirmed decisions')
  .requiredOption('--app <id>', 'app id under apps/')
  .option('--repo <path>', 'override output.repoPath')
  .option('--no-install', 'do not run npm install in the suite')
  .action(async (opts: { app: string; repo?: string; install: boolean }) => {
    const res = await runCompile({ appId: opts.app, stateRoot: stateRoot(), install: opts.install, ...(opts.repo ? { repoPath: opts.repo } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('run')
  .description('run the suite repo and collect results.json (zero LLM calls)')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .addOption(new Option('--suite <name>', 'tag to run').choices(['smoke', 'regression', 'authz', 'all']).default('regression'))
  .option('--repo <path>', 'override output.repoPath')
  .action(async (opts: { app: string; target?: 'staging'; suite: 'smoke' | 'regression' | 'authz' | 'all'; repo?: string }) => {
    const res = await runSuite({ appId: opts.app, stateRoot: stateRoot(), suite: opts.suite, target: opts.target, ...(opts.repo ? { repoPath: opts.repo } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('seed')
  .description('create tagged records through the observed create operation (en_IN factory)')
  .requiredOption('--app <id>', 'app id under apps/')
  .requiredOption('--entity <name>', 'entity from entities.yaml')
  .option('--count <n>', 'how many', (v) => Number.parseInt(v, 10), 1)
  .option('--role <id>', 'create as this role (default: the role the crawl saw creating it)')
  .addOption(targetOption())
  .action(async (opts: { app: string; entity: string; count: number; role?: string; target?: 'staging' }) => {
    const res = await runSeed({ appId: opts.app, stateRoot: stateRoot(), entity: opts.entity, count: opts.count, target: opts.target, ...(opts.role ? { role: opts.role } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('teardown')
  .description("tear down what a run created (also after it was killed halfway), from the ledger")
  .requiredOption('--app <id>', 'app id under apps/')
  .requiredOption('--run <runId>', 'the run to clean up')
  .addOption(targetOption())
  .action(async (opts: { app: string; run: string; target?: 'staging' }) => {
    const res = await runTeardown({ appId: opts.app, stateRoot: stateRoot(), runId: opts.run, target: opts.target });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('orphans')
  .description('list Pramaan-tagged records still live in the app (any run, or one with --run)')
  .requiredOption('--app <id>', 'app id under apps/')
  .option('--run <runId>', 'only this run')
  .addOption(targetOption())
  .action(async (opts: { app: string; run?: string; target?: 'staging' }) => {
    const res = await runOrphans({ appId: opts.app, stateRoot: stateRoot(), target: opts.target, ...(opts.run ? { runId: opts.run } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('bench')
  .description('seeded-bug recall and precision of the compiled suite (demo restarts per bug; other apps: manual activation)')
  .requiredOption('--app <id>', 'app id under apps/')
  .option('--bugs <ids>', 'all, or a comma-separated list of bug ids', 'all')
  .option('--repo <path>', 'override output.repoPath')
  .action(async (opts: { app: string; bugs: string; repo?: string }) => {
    const res = await runBench({ appId: opts.app, stateRoot: stateRoot(), bugs: opts.bugs === 'all' ? 'all' : opts.bugs.split(',').map((b) => b.trim()), ...(opts.repo ? { repoPath: opts.repo } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('mutate')
  .description('fault injection: does each regression test fail when the response it relies on is corrupted?')
  .requiredOption('--app <id>', 'app id under apps/')
  .addOption(targetOption())
  .option('--ops <ops>', 'limit to these operations, e.g. "GET /api/leave-balance" (comma-separated)')
  .option('--repo <path>', 'override output.repoPath')
  .action(async (opts: { app: string; target?: 'staging'; ops?: string; repo?: string }) => {
    const res = await runMutate({ appId: opts.app, stateRoot: stateRoot(), target: opts.target, ...(opts.ops ? { ops: opts.ops.split(',').map((o) => o.trim()) } : {}), ...(opts.repo ? { repoPath: opts.repo } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program
  .command('triage')
  .description('classify failures (bug / flaky / locator drift / environment / spec change); quarantine, heal or file')
  .requiredOption('--app <id>', 'app id under apps/')
  .requiredOption('--results <path>', 'a results.json, or a directory of CI results artifacts')
  .addOption(targetOption())
  .option('--repo <path>', 'override output.repoPath')
  .option('--no-rerun', 'classify without isolated reruns')
  .option('--no-heal', 'do not patch page objects for locator drift')
  .action(async (opts: { app: string; results: string; target?: 'staging'; repo?: string; rerun: boolean; heal: boolean }) => {
    const res = await runTriage({ appId: opts.app, stateRoot: stateRoot(), results: opts.results, target: opts.target, rerun: opts.rerun, heal: opts.heal, ...(opts.repo ? { repoPath: opts.repo } : {}) });
    console.log(res.summary);
    process.exitCode = res.exitCode;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

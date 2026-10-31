#!/usr/bin/env node
// Pramaan CLI. One subcommand per pipeline stage (§3.4).
import { Command, Option } from 'commander';
import { repoRoot } from '../core/config.js';
import { stateRoot } from '../core/paths.js';
import { runAuthz } from '../authz/run.js';
import { runCrawl } from '../crawler/crawl.js';
import { runOnboard } from '../onboarding/onboard.js';
import { exportReview, importReview, inquirerPrompter, queueSummary, runInteractiveReview } from '../lead/review.js';
import { runInfer } from '../spec/infer.js';
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

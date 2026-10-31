#!/usr/bin/env node
// Pramaan CLI. One subcommand per pipeline stage (§3.4).
import { Command, Option } from 'commander';
import { repoRoot } from '../core/config.js';
import { stateRoot } from '../core/paths.js';
import { runCrawl } from '../crawler/crawl.js';
import { runOnboard } from '../onboarding/onboard.js';
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

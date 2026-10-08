#!/usr/bin/env node
// Pramaan CLI. One subcommand per pipeline stage (§3.4). M0: doctor.
import { Command, Option } from 'commander';
import { repoRoot } from '../core/config.js';
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

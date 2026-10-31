// `pramaan review` (§8 M5): one item at a time (interactive), or a Markdown checklist (--export / --import).
// Interactive minutes are measured wall-clock from start to quit and recorded as lead.session.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { newRunId } from '../core/run-id.js';
import { istDate } from '../core/time.js';
import { applyDecision, backingFile, type Verdict } from './decide.js';
import { buildQueue, loadSources, minutesUsedThisWeek, type Queue, type ReviewItem } from './queue.js';

export type Choice = { action: Verdict; note?: string } | { action: 'edit' | 'skip' | 'quit' };
export type Prompter = (item: ReviewItem, position: { index: number; total: number }) => Promise<Choice>;

export interface ReviewOptions {
  appId: string;
  stateRoot: string;
  by: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function open(opts: ReviewOptions): { queue: Queue; ledger: Ledger; runId: string; budget: number } {
  const { config } = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  const now = (opts.now ?? (() => new Date()))();
  const used = minutesUsedThisWeek(ledger, now);
  const left = Math.max(0, config.lead.minutesPerWeek - used);
  return { queue: buildQueue(loadSources(opts.stateRoot, config.id), left, used), ledger, runId: newRunId(now), budget: config.lead.minutesPerWeek };
}

export function formatQueue(q: Queue, budget: number): string {
  return [
    `review queue — ${q.items.length} items fit this week (≈${q.items.reduce((n, i) => n + i.estMinutes, 0).toFixed(1)} min) · ` +
      `${q.minutesUsed.toFixed(1)}/${budget} min used · ${q.overflow.length} deferred to next week`,
    ...q.items.slice(0, 25).map((i) => `  ${i.id.padEnd(30)} ${i.kind.padEnd(10)} ${(i.risk * i.uncertainty).toFixed(2).padStart(5)}  ${i.summary.slice(0, 90)}`),
    ...(q.items.length > 25 ? [`  … ${q.items.length - 25} more`] : []),
  ].join('\n');
}

export async function runInteractiveReview(opts: ReviewOptions, ask: Prompter, editor?: (file: string) => void): Promise<{ decided: number; minutes: number; quit: boolean }> {
  const clock = opts.now ?? (() => new Date());
  const started = clock().getTime();
  const { queue, ledger, runId } = open(opts);
  const ctx = { stateRoot: opts.stateRoot, app: opts.appId, by: opts.by, ledger, runId };
  let decided = 0;
  let quit = false;
  for (let i = 0; i < queue.items.length && !quit; i++) {
    const item = queue.items[i];
    if (!item) continue;
    for (;;) {
      const c = await ask(item, { index: i, total: queue.items.length });
      if (c.action === 'confirm' || c.action === 'reject') {
        applyDecision(item, c.action, ctx, c.note);
        decided += 1;
      } else if (c.action === 'edit') {
        (editor ?? openInEditor)(backingFile(item, ctx));
        continue; // ask again after editing
      } else if (c.action === 'quit') quit = true;
      break;
    }
  }
  const minutes = Math.round(((clock().getTime() - started) / 60_000) * 100) / 100;
  ledger.append({ runId, type: 'lead.session', actor: opts.by, data: { minutes, itemsDecided: decided, mode: 'interactive' } });
  return { decided, minutes, quit };
}

function openInEditor(file: string): void {
  const editor = process.env['EDITOR'] ?? process.env['VISUAL'] ?? (process.platform === 'win32' ? 'notepad' : 'vi');
  spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
}

/** The real console prompter (@inquirer/prompts). */
export async function inquirerPrompter(item: ReviewItem, pos: { index: number; total: number }): Promise<Choice> {
  const { select, input } = await import('@inquirer/prompts');
  const lines = [
    '',
    `[${pos.index + 1}/${pos.total}] ${item.id} · ${item.kind} · ~${item.estMinutes} min`,
    `  ${item.summary}`,
    ...item.detail.map((d) => `    ${d}`),
    ...item.evidence.slice(0, 5).map((e) => `    evidence ${e.id} ${e.kind} ${e.ref}${e.excerpt ? ` — ${e.excerpt.slice(0, 120)}` : ''}`),
  ];
  console.log(lines.join('\n'));
  const action = await select<'confirm' | 'reject' | 'edit' | 'skip' | 'quit'>({
    message: item.kind === 'finding' ? 'Is this a real bug?' : item.kind === 'question' ? 'Answer and confirm?' : 'Decision',
    choices: [
      { value: 'confirm', name: item.kind === 'finding' ? 'confirm (true positive)' : 'confirm' },
      { value: 'reject', name: item.kind === 'finding' ? 'reject (false positive)' : 'reject' },
      { value: 'edit', name: 'edit the file, then decide' },
      { value: 'skip', name: 'skip for now' },
      { value: 'quit', name: 'quit (records your minutes)' },
    ],
  });
  if (action === 'confirm' || action === 'reject') {
    const note = await input({ message: item.kind === 'question' ? 'Your answer:' : 'Note (optional):' });
    return note.trim() ? { action, note: note.trim() } : { action };
  }
  return { action };
}

// ---------------------------------------------------------------- export / import

export function exportReview(opts: ReviewOptions): { path: string; items: number } {
  const { queue, budget } = open(opts);
  const dir = workspaceDir(opts.stateRoot, opts.appId, 'review');
  mkdirSync(dir, { recursive: true });
  const date = istDate((opts.now ?? (() => new Date()))());
  const path = join(dir, `REVIEW-${date}.md`);
  const block = (i: ReviewItem): string =>
    [
      `### ${i.id} · ${i.kind} · ~${i.estMinutes} min`,
      '',
      i.summary,
      '',
      ...i.detail.map((d) => `> ${d}`),
      ...(i.evidence.length > 0 ? ['', ...i.evidence.slice(0, 5).map((e) => `- evidence \`${e.id}\` ${e.kind} \`${e.ref}\``)] : []),
      '',
      '- [ ] confirm',
      '- [ ] reject',
      '- note: ',
      '',
    ].join('\n');
  writeFileSync(
    path,
    [
      `# Pramaan review — ${opts.appId} — ${date}`,
      '',
      `${queue.items.length} items (≈${queue.items.reduce((n, i) => n + i.estMinutes, 0).toFixed(1)} min of your ${budget}-minute week). ` +
        'Tick **one** box per item, add a note if useful, then run `pramaan review --import <this file>`.',
      '',
      ...queue.items.map(block),
    ].join('\n'),
  );
  return { path, items: queue.items.length };
}

export interface ImportResult {
  decided: number;
  skipped: number;
  conflicts: string[];
}

/** Reads ticked boxes back. An item with both or neither box ticked is skipped (and reported when both). */
export function importReview(opts: ReviewOptions, file: string): ImportResult {
  const { queue, ledger, runId } = open(opts);
  const ctx = { stateRoot: opts.stateRoot, app: opts.appId, by: opts.by, ledger, runId };
  const text = readFileSync(file, 'utf8');
  const blocks = text.split(/^### /m).slice(1);
  let decided = 0;
  let minutes = 0;
  const conflicts: string[] = [];
  for (const b of blocks) {
    const id = b.split(' · ')[0]?.trim() ?? '';
    const confirm = /^- \[[xX]\] confirm/m.test(b);
    const reject = /^- \[[xX]\] reject/m.test(b);
    const note = /^- note:[ \t]*(.*)$/m.exec(b)?.[1]?.trim();
    const item = queue.items.find((i) => i.id === id) ?? queue.overflow.find((i) => i.id === id);
    if (!item || confirm === reject) {
      if (confirm && reject) conflicts.push(id);
      continue;
    }
    applyDecision(item, confirm ? 'confirm' : 'reject', ctx, note || undefined);
    decided += 1;
    minutes += item.estMinutes;
  }
  // Checklist time cannot be measured; record the estimate and say so.
  ledger.append({ runId, type: 'lead.session', actor: opts.by, data: { minutes, itemsDecided: decided, mode: 'import', estimated: true } });
  return { decided, skipped: blocks.length - decided, conflicts };
}

export function queueSummary(opts: ReviewOptions): string {
  const { queue, budget } = open(opts);
  return formatQueue(queue, budget);
}

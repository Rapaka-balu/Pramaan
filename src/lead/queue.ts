// Lead review queue (§8 M5): everything awaiting a human decision, ranked by risk × uncertainty and capped at
// the minutes left in this week's budget. Overflow waits for next week (the digest says so).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadMatrix, type MatrixRow } from '../authz/matrix-io.js';
import type { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { Finding, type Evidence } from '../core/schemas.js';
import { istParts } from '../core/time.js';
import { loadAssertions } from '../spec/assertion-proposer.js';
import { loadRules, type RuleT } from '../spec/rule-proposer.js';
import type { AssertionT } from '../dsl/validate.js';

export type ItemKind = 'rule' | 'matrix-row' | 'assertion' | 'finding' | 'question';
export const EST_MINUTES: Record<ItemKind, number> = { rule: 0.5, 'matrix-row': 0.25, assertion: 1.5, finding: 2, question: 2 };

export interface ReviewItem {
  kind: ItemKind;
  id: string; // R-xxx | M:<operation> | A-xxx | F-xxxx
  risk: number;
  uncertainty: number;
  estMinutes: number;
  summary: string;
  detail: string[];
  evidence: Evidence[];
}

export interface Queue {
  items: ReviewItem[];
  overflow: ReviewItem[];
  minutesLeft: number;
  minutesUsed: number;
}

const SEVERITY_RISK: Record<string, number> = { S1: 5, S2: 4, S3: 3, S4: 2 };

/** Monday 00:00 IST of the week containing `now`, as epoch ms. */
export function weekStartIst(now: Date): number {
  const p = istParts(now);
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return day.getTime() - dow * 86_400_000 - 330 * 60_000;
}

export function minutesUsedThisWeek(ledger: Ledger, now: Date): number {
  const start = weekStartIst(now);
  return ledger
    .query({ type: 'lead.session' })
    .filter((e) => Date.parse(e.ts) >= start)
    .reduce((n, e) => n + (typeof e.data['minutes'] === 'number' ? e.data['minutes'] : 0), 0);
}

function ruleItem(r: RuleT, hasAssertion: boolean): ReviewItem {
  const question = r.openQuestion !== undefined;
  const kind: ItemKind = question ? 'question' : 'rule';
  return {
    kind,
    id: r.id,
    // risk = criticality × (1 + recent change) × (1 + oracle weakness); recent change is 0 until M16's drift data.
    risk: r.criticality * (1 + 0) * (1 + (hasAssertion ? 0 : 1)),
    uncertainty: question ? 1 : 1 - r.confidence,
    estMinutes: EST_MINUTES[kind],
    summary: `${r.kind}: ${r.title}`,
    detail: [
      ...(question ? [`Question: ${r.openQuestion ?? ''}`] : []),
      `source ${r.source} · confidence ${r.confidence} · criticality ${r.criticality}`,
      ...(r.operations.length > 0 ? [`operations: ${r.operations.join(', ')}`] : []),
    ],
    evidence: r.evidence,
  };
}

function matrixItem(row: MatrixRow): ReviewItem {
  const cells = Object.entries(row.expected);
  const unknown = cells.filter(([, e]) => e === 'unknown').length;
  return {
    kind: 'matrix-row',
    id: `M:${row.operation}`,
    risk: 4 * (row.operation.startsWith('GET') ? 1 : 1.25),
    uncertainty: cells.length === 0 ? 1 : Math.max(0.2, unknown / cells.length),
    estMinutes: EST_MINUTES['matrix-row'],
    summary: `authz: ${row.operation} (owner ${row.ownerRole})`,
    detail: cells.map(([actor, exp]) => {
      const o = row.observed[actor];
      return `${actor.padEnd(24)} expected ${exp.padEnd(9)} observed ${o ? `${o.outcome} (HTTP ${o.status})` : '—'}`;
    }),
    evidence: [],
  };
}

function assertionItem(a: AssertionT, rule: RuleT | undefined): ReviewItem {
  return {
    kind: 'assertion',
    id: a.id,
    risk: rule?.criticality ?? 3,
    uncertainty: 0.5,
    estMinutes: EST_MINUTES.assertion,
    summary: `assertion for ${a.ruleId}: ${a.title}`,
    detail: describeAssertion(a),
    evidence: rule?.evidence ?? [],
  };
}

/** The assertion as plain English, for review. */
export function describeAssertion(a: AssertionT): string[] {
  const step = (s: AssertionT['act'][number]): string =>
    s.kind === 'api' ? `${s.actor} calls ${s.op.method} ${s.op.path}${s.body !== undefined ? ` with ${JSON.stringify(s.body)}` : ''}` : `${s.actor} runs flow ${s.flow}`;
  return [
    ...a.arrange.map((s) => `Arrange: ${step(s)}`),
    ...a.act.map((s) => `Act: ${step(s)}`),
    ...a.assert.map((c) => `Assert: ${c.message}${c.kind === 'status' ? ` (HTTP ${c.oneOf.join('/')} on ${c.step})` : c.kind === 'delta' ? ` (${c.path} changes by ${c.expected})` : ''}`),
    ...a.cleanup.map((s) => `Cleanup: ${step(s)}`),
  ];
}

function findingItem(f: z.infer<typeof Finding>): ReviewItem {
  return {
    kind: 'finding',
    id: f.id,
    risk: SEVERITY_RISK[f.severity] ?? 3,
    uncertainty: 0.5,
    estMinutes: EST_MINUTES.finding,
    summary: `${f.severity} ${f.oracle}: ${f.title}`,
    detail: f.reproSteps,
    evidence: f.evidence,
  };
}

export interface QueueSources {
  rules: RuleT[];
  rows: MatrixRow[];
  assertions: AssertionT[];
  findings: z.infer<typeof Finding>[];
}

export function loadSources(stateRoot: string, app: string): QueueSources {
  const spec = workspaceDir(stateRoot, app, 'spec');
  const fdir = workspaceDir(stateRoot, app, 'findings');
  return {
    rules: loadRules(join(spec, 'rules.yaml')),
    rows: loadMatrix(join(spec, 'role-matrix.yaml')).rows,
    assertions: loadAssertions(join(spec, 'assertions')),
    findings: existsSync(fdir)
      ? readdirSync(fdir).filter((f) => /^F-\d{4,}\.json$/.test(f)).sort().map((f) => Finding.parse(JSON.parse(readFileSync(join(fdir, f), 'utf8'))))
      : [],
  };
}

export function buildQueue(src: QueueSources, minutesLeft: number, minutesUsed = 0): Queue {
  const all: ReviewItem[] = [
    ...src.rules.filter((r) => r.status === 'proposed').map((r) => ruleItem(r, r.assertionIds.length > 0)),
    ...src.rows.filter((r) => r.status === 'proposed').map(matrixItem),
    ...src.assertions.filter((a) => a.status === 'proposed').map((a) => assertionItem(a, src.rules.find((r) => r.id === a.ruleId))),
    ...src.findings.filter((f) => f.status === 'queued').map(findingItem),
  ];
  all.sort((a, b) => b.risk * b.uncertainty - a.risk * a.uncertainty || a.id.localeCompare(b.id));
  const items: ReviewItem[] = [];
  const overflow: ReviewItem[] = [];
  let budget = minutesLeft;
  for (const it of all) {
    if (it.estMinutes <= budget + 1e-9) {
      items.push(it);
      budget -= it.estMinutes;
    } else overflow.push(it);
  }
  return { items, overflow, minutesLeft, minutesUsed };
}

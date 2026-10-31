// Rule proposer (§8 M5): domain-pack matches (deterministic) + frontier-LLM proposals from a redacted evidence
// digest. Evidence discipline: an LLM rule citing any id not in its input is dropped and counted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import type { Ledger } from '../core/ledger.js';
import { Rule, RuleKind, RulesFile, type Evidence } from '../core/schemas.js';
import { nowIso } from '../core/time.js';
import type { LlmClient } from '../llm/client.js';
import { loadPrompt } from '../llm/prompts.js';
import type { PackMatch } from './domain-pack.js';

export type RuleT = z.infer<typeof Rule>;
export const MAX_NEW_RULES = 40;
export const DUPLICATE_SIMILARITY = 0.85;

export function loadRules(path: string): RuleT[] {
  if (!existsSync(path)) return [];
  return RulesFile.parse(parseYaml(readFileSync(path, 'utf8'))).rules;
}
export function saveRules(path: string, rules: readonly RuleT[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toYaml(RulesFile.parse({ schemaVersion: 1, rules }), { lineWidth: 0 }));
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').trim();
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = norm(s);
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}
/** Dice coefficient over character bigrams of the normalized titles (1 = identical). */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of x) {
    inter += Math.min(n, y.get(g) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total === 0 ? 0 : (2 * inter) / total;
}

export function nextRuleId(rules: readonly RuleT[]): string {
  const max = rules.reduce((n, r) => Math.max(n, Number(r.id.slice(2))), 0);
  return `R-${String(max + 1).padStart(3, '0')}`;
}

/** The LLM-facing shape (no free-form evidence objects: ids only, resolved against the digest). */
export const LlmRuleProposals = z.object({
  rules: z
    .array(
      z.object({
        title: z.string(),
        kind: RuleKind,
        confidence: z.number(),
        entities: z.array(z.string()),
        operations: z.array(z.string()),
        evidenceIds: z.array(z.string()),
        criticality: z.number().int(),
        openQuestion: z.string().optional(),
      }),
    )
    .max(60),
});

export interface DigestItem {
  evidence: Evidence;
  text: string; // one line, what the model reads
}

export interface ProposeResult {
  rules: RuleT[]; // all rules after the run (existing first)
  added: RuleT[];
  rejected: { title: string; reason: string }[];
  llmSource: 'live' | 'cache' | 'fallback';
}

export async function proposeRules(opts: {
  existing: readonly RuleT[];
  packMatches: readonly PackMatch[];
  digest: readonly DigestItem[];
  knownOps: ReadonlySet<string>;
  llm: LlmClient;
  ledger: Ledger;
  runId: string;
}): Promise<ProposeResult> {
  const rules = [...opts.existing];
  const added: RuleT[] = [];
  const rejected: ProposeResult['rejected'] = [];
  const evidenceById = new Map(opts.digest.map((d) => [d.evidence.id, d.evidence]));
  const isDuplicate = (title: string): boolean => rules.some((r) => titleSimilarity(r.title, title) >= DUPLICATE_SIMILARITY);
  const add = (r: Omit<RuleT, 'id' | 'status' | 'version' | 'assertionIds'>): void => {
    if (added.length >= MAX_NEW_RULES) {
      rejected.push({ title: r.title, reason: `cap of ${MAX_NEW_RULES} new rules per run reached` });
      return;
    }
    const rule = Rule.parse({ ...r, id: nextRuleId(rules), status: 'proposed', version: 1, assertionIds: [] });
    rules.push(rule);
    added.push(rule);
    opts.ledger.append({ runId: opts.runId, type: 'rule.proposed', actor: 'pramaan:rule-proposer', data: { ruleId: rule.id, source: rule.source, title: rule.title } });
  };

  for (const m of opts.packMatches) {
    if (isDuplicate(m.title)) continue;
    add({ title: m.title, kind: m.template.kind, confidence: 0.7, source: 'domain-pack', entities: [m.entity], operations: m.operations, evidence: m.evidence, criticality: m.template.criticality });
  }

  const prompt = loadPrompt('rule-proposer');
  const digestText = opts.digest.map((d) => `${d.evidence.id} [${d.evidence.kind}] ${d.text}`).join('\n');
  const already = rules.map((r) => `- ${r.title}`).join('\n');
  const res = await opts.llm.structured({
    purpose: 'rule-proposal',
    tier: 'frontier',
    system: prompt.body,
    user: `Rules already known (do not repeat):\n${already || '(none)'}\n\nEvidence digest:\n${digestText}`,
    schema: LlmRuleProposals,
    schemaName: 'rule_proposals',
    promptVersion: prompt.version,
    maxTokens: 8000,
    fallback: () => ({ rules: [] }),
  });

  for (const p of res.value.rules) {
    const reject = (reason: string): void => {
      rejected.push({ title: p.title, reason });
      opts.ledger.append({ runId: opts.runId, type: 'llm.rejected-output', actor: 'pramaan:rule-proposer', data: { purpose: 'rule-proposal', title: p.title.slice(0, 200), reason } });
    };
    const unknown = p.evidenceIds.filter((id) => !evidenceById.has(id));
    if (p.evidenceIds.length === 0) reject('cites no evidence');
    else if (unknown.length > 0) reject(`cites unknown evidence ${unknown.join(', ')}`);
    else if (p.operations.some((o) => !opts.knownOps.has(o))) reject(`uses operations not in openapi.observed: ${p.operations.filter((o) => !opts.knownOps.has(o)).join(', ')}`);
    else if (p.title.length < 10 || p.title.length > 200) reject('title must be 10–200 characters');
    else if (isDuplicate(p.title)) reject('duplicate of an existing rule');
    else {
      add({
        title: p.title,
        kind: p.kind,
        confidence: Math.min(1, Math.max(0, p.confidence)),
        source: 'inferred',
        entities: p.entities,
        operations: p.operations,
        evidence: p.evidenceIds.map((id) => evidenceById.get(id)).filter((e): e is Evidence => e !== undefined),
        criticality: Math.min(5, Math.max(1, p.criticality)),
        ...(p.openQuestion ? { openQuestion: p.openQuestion } : {}),
      });
    }
  }
  return { rules, added, rejected, llmSource: res.source };
}

/** Seed rules (apps/<id>/seed-rules.yaml) join the rule set once, with their decisions; a taken id is renumbered. */
export function mergeSeedRules(existing: readonly RuleT[], seed: readonly RuleT[]): RuleT[] {
  const out = [...existing];
  for (const s of seed) {
    if (out.some((r) => titleSimilarity(r.title, s.title) >= DUPLICATE_SIMILARITY)) continue;
    out.push(out.some((r) => r.id === s.id) ? { ...s, id: nextRuleId(out) } : s);
  }
  return out;
}

export const decide = (r: RuleT, status: 'confirmed' | 'rejected', by: string, note?: string): RuleT => ({
  ...r,
  status,
  decision: { by, at: nowIso(), ...(note ? { note } : {}) },
});

// Assertion proposer (§8 M5): for each confirmed rule without an assertion, the frontier LLM proposes a DSL
// assertion (fallback: the domain-pack template). Validated statically, then dry-run; one that cannot run
// (as opposed to failing a check) is discarded with its reason.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Ledger } from '../core/ledger.js';
import { Assertion } from '../core/schemas.js';
import { runAssertion, type RunnerDeps, type RunResult } from '../dsl/runner.js';
import { validateAssertion, type AssertionT } from '../dsl/validate.js';
import type { LlmClient } from '../llm/client.js';
import { loadPrompt } from '../llm/prompts.js';
import { assertionFromTemplate, type Binding, type PackTemplate } from './domain-pack.js';
import type { RuleT } from './rule-proposer.js';

export function loadAssertions(dir: string): AssertionT[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^A-\d{3,}\.json$/.test(f))
    .sort()
    .map((f) => Assertion.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}
export function saveAssertion(dir: string, a: AssertionT): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${a.id}.json`), `${JSON.stringify(Assertion.parse(a), null, 2)}\n`);
}

const LlmStep = z.object({
  kind: z.literal('api'),
  id: z.string(),
  actor: z.string(),
  op: z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string() }),
  pathParams: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  bodyJson: z.string(),
  capture: z.record(z.string(), z.string()),
});
/** LLM-facing assertion: bodies as JSON strings, checks as loose objects (validated after conversion). */
export const LlmAssertion = z.object({
  title: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  arrange: z.array(LlmStep),
  act: z.array(LlmStep),
  assert: z.array(z.record(z.string(), z.unknown())),
  cleanup: z.array(LlmStep),
});

function fromLlm(x: z.infer<typeof LlmAssertion>, id: string, ruleId: string): unknown {
  const step = (s: z.infer<typeof LlmStep>): Record<string, unknown> => {
    const { bodyJson, ...rest } = s;
    let body: unknown;
    if (bodyJson.trim() !== '') {
      try {
        body = JSON.parse(bodyJson) as unknown;
      } catch {
        body = { __invalidJson: bodyJson };
      }
    }
    return body === undefined ? rest : { ...rest, body };
  };
  return { id, ruleId, title: x.title, data: x.data, arrange: x.arrange.map(step), act: x.act.map(step), assert: x.assert, cleanup: x.cleanup.map(step), status: 'proposed' };
}

export interface AssertionOutcome {
  ruleId: string;
  assertionId?: string;
  source: 'llm' | 'domain-pack' | 'none';
  status: 'kept' | 'discarded' | 'no-template';
  dryRun?: Pick<RunResult, 'passed' | 'aborted'> & { abortReason?: string | undefined; failed: string[] };
  reason?: string;
}

export async function proposeAssertions(opts: {
  rules: RuleT[];
  dir: string;
  bindings: readonly Binding[];
  templates: readonly PackTemplate[];
  knownOps: ReadonlySet<string>;
  roles: readonly string[];
  llm: LlmClient;
  ledger: Ledger;
  runId: string;
  /** Dry-run deps; without them assertions are kept unverified (no network). */
  dryRun?: RunnerDeps;
}): Promise<AssertionOutcome[]> {
  const out: AssertionOutcome[] = [];
  const existing = loadAssertions(opts.dir);
  let next = existing.reduce((n, a) => Math.max(n, Number(a.id.slice(2))), 0) + 1;
  const prompt = loadPrompt('assertion-proposer');
  const opsList = [...opts.knownOps].sort().join('\n');

  for (const rule of opts.rules) {
    if (rule.status !== 'confirmed' || rule.assertionIds.length > 0 || existing.some((a) => a.ruleId === rule.id)) continue;
    const id = `A-${String(Number(rule.id.slice(2))).padStart(3, '0')}`;
    const assertionId = existing.some((a) => a.id === id) ? `A-${String(next++).padStart(3, '0')}` : id;
    const templateId = rule.evidence.find((e) => e.kind === 'domain-pack')?.ref.split('#')[1];
    const template = opts.templates.find((t) => t.id === templateId);
    const binding = opts.bindings.find((b) => rule.entities.includes(b.entity.name)) ?? opts.bindings[0];
    const offset = 30 + (Number(rule.id.slice(2)) % 50) * 3; // its own date window per rule
    const fallback = (): z.infer<typeof LlmAssertion> | null => null;

    let candidate: unknown;
    let source: AssertionOutcome['source'] = 'none';
    const templated = template?.assertion && binding ? assertionFromTemplate(template.assertion, binding, rule.id, assertionId, offset) : undefined;
    if (templated) {
      candidate = templated;
      source = 'domain-pack';
    } else {
      const res = await opts.llm.structured({
        purpose: 'assertion-proposal',
        tier: 'frontier',
        system: prompt.body,
        user: [
          `Rule ${rule.id}: ${rule.title}`,
          `Operations (templates):\n${opsList}`,
          `Roles (actors): ${opts.roles.join(', ')}`,
          rule.operations.length > 0 ? `Operations the rule is about: ${rule.operations.join(', ')}` : '',
        ].join('\n\n'),
        schema: LlmAssertion.nullable(),
        schemaName: 'assertion',
        promptVersion: prompt.version,
        maxTokens: 6000,
        fallback,
      });
      if (res.value) {
        candidate = fromLlm(res.value, assertionId, rule.id);
        source = 'llm';
      }
    }
    if (candidate === undefined) {
      out.push({ ruleId: rule.id, source: 'none', status: 'no-template', reason: 'no domain-pack template and no LLM proposal (keyless)' });
      continue;
    }
    const v = validateAssertion(candidate, opts.knownOps);
    if (!v.ok) {
      const reason = v.errors.join('; ');
      opts.ledger.append({ runId: opts.runId, type: 'llm.rejected-output', actor: 'pramaan:assertion-proposer', data: { purpose: 'assertion-proposal', ruleId: rule.id, reason: reason.slice(0, 500) } });
      out.push({ ruleId: rule.id, source, status: 'discarded', reason });
      continue;
    }
    let dry: AssertionOutcome['dryRun'];
    if (opts.dryRun) {
      const r = await runAssertion(v.assertion, opts.dryRun);
      dry = { passed: r.passed, aborted: r.aborted, abortReason: r.abortReason, failed: r.checks.filter((c) => !c.ok).map((c) => `${c.message} (actual ${JSON.stringify(c.actual)}, expected ${JSON.stringify(c.expected)})`) };
      if (r.aborted) {
        out.push({ ruleId: rule.id, source, status: 'discarded', dryRun: dry, reason: `cannot run: ${r.abortReason ?? 'unknown'}` });
        continue;
      }
    }
    saveAssertion(opts.dir, v.assertion);
    rule.assertionIds = [...rule.assertionIds, v.assertion.id];
    out.push({ ruleId: rule.id, assertionId: v.assertion.id, source, status: 'kept', ...(dry ? { dryRun: dry } : {}) });
  }
  return out;
}

// The M5 part of `pramaan infer`: evidence digest → rule proposals → assertion proposals (+ dry-run).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Ledger } from '../core/ledger.js';
import type { Http } from '../core/net.js';
import { RulesFile, type AppConfig } from '../core/schemas.js';
import { Steward } from '../data/steward.js';
import { LlmClient } from '../llm/client.js';
import { workspaceDir } from '../core/paths.js';
import { proposeAssertions, type AssertionOutcome } from './assertion-proposer.js';
import { bindEntity, ev, loadDomainPack, matchTemplates, type Binding, type UiFacts } from './domain-pack.js';
import type { Entity } from './entities.js';
import type { ApiModel } from './har-to-openapi.js';
import { loadRules, mergeSeedRules, proposeRules, saveRules, type DigestItem, type ProposeResult } from './rule-proposer.js';

export interface RulesStepResult {
  proposal: ProposeResult;
  assertions: AssertionOutcome[];
  llmRequests: number;
  rulesPath: string;
}

interface UiState {
  role: string;
  route: string;
  aria: string;
  ref: string;
}

/** One line per operation, entity and screen, each with an evidence id the LLM may cite. */
export function buildDigest(model: ApiModel, entities: readonly Entity[], states: readonly UiState[], maxStates = 40): DigestItem[] {
  const items: DigestItem[] = [];
  for (const op of model.operations) {
    const fields = (s: { properties?: Record<string, { type?: string | string[] }> } | undefined): string =>
      Object.entries(s?.properties ?? {}).map(([k, v]) => `${k}:${Array.isArray(v.type) ? v.type.join('|') : (v.type ?? '?')}`).join(', ');
    const ok = Object.entries(op.responseSchemas).find(([s]) => s.startsWith('2'))?.[1];
    items.push({
      evidence: ev('response', op.key),
      text: `${op.key} · status by role ${JSON.stringify(op.statusByRole)}${op.requestSchema ? ` · request {${fields(op.requestSchema)}}` : ''}${ok ? ` · response {${fields(ok.items ?? ok)}}` : ''}`,
    });
  }
  for (const e of entities) {
    const sm = e.stateMachine;
    if (!sm) continue;
    for (const t of sm.transitions.filter((x) => x.observed)) {
      items.push({ evidence: ev('replay', t.evidenceRefs[0] ?? `${e.name}:${t.from}->${t.to}`), text: `${e.name}.${sm.field}: ${t.from} → ${t.to} via ${t.op} by ${t.actors.join('/')}` });
    }
  }
  // UI text: headings, labels and alerts per screen (the parts that state rules), first states per route.
  const seen = new Set<string>();
  for (const s of states) {
    const key = `${s.role}|${s.route}`;
    if (seen.has(key) || seen.size >= maxStates) continue;
    seen.add(key);
    const lines = s.aria
      .split(/\r?\n/)
      .map((l) => /- (heading|alert|textbox|checkbox|status|paragraph)(?: "([^"]+)")?:?\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]} ${m[2] ?? m[3] ?? ''}`.trim())
      .slice(0, 12);
    if (lines.length > 0) items.push({ evidence: ev('ui-text', s.ref), text: `screen ${s.route} (${s.role}): ${lines.join(' · ')}` });
  }
  return items;
}

export function uiFacts(states: readonly UiState[]): UiFacts {
  return {
    dateStates: states.filter((s) => /\b\d{2}\/\d{2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(s.aria)).map((s) => s.ref),
    balanceStates: states.filter((s) => /balance/i.test(s.aria)).map((s) => s.ref),
  };
}

export async function runRulesStep(ctx: {
  config: AppConfig;
  repoRoot: string;
  stateRoot: string;
  model: ApiModel;
  entities: readonly Entity[];
  states: readonly UiState[];
  readyRoles: readonly string[];
  ledger: Ledger;
  runId: string;
  runTag: string;
  /** Present when the network is allowed: assertions are dry-run, and created records torn down. */
  net?: { http: Http; apiOrigin: string; headersFor: (role: string) => Record<string, string> | undefined; learned: Map<string, string> };
}): Promise<RulesStepResult> {
  const { config } = ctx;
  const specDir = workspaceDir(ctx.stateRoot, config.id, 'spec');
  const rulesPath = join(specDir, 'rules.yaml');
  let llmRequests = 0;
  const llm = new LlmClient({
    appId: config.id,
    root: ctx.repoRoot,
    onCall: (r) => {
      if (!r.fallback && !r.cached) llmRequests += 1;
      ctx.ledger.append({ runId: ctx.runId, type: 'llm.call', actor: 'pramaan:infer', data: { ...r } });
    },
  });

  // Rules: existing + seed + pack matches + LLM proposals.
  let existing = loadRules(rulesPath);
  const seedPath = join(ctx.repoRoot, 'apps', config.id, 'seed-rules.yaml');
  if (existsSync(seedPath)) existing = mergeSeedRules(existing, RulesFile.parse(parseYaml(readFileSync(seedPath, 'utf8'))).rules);
  const roles = config.roles.map((r) => ({ role: r.id, tenant: r.tenant }));
  const bindings: Binding[] = ctx.entities.flatMap((e) => {
    const b = e.createOp ? bindEntity(e, ctx.model, roles, config.safety.runTagPrefix) : undefined;
    return b ? [b] : [];
  });
  const pack = config.domainPack && existsSync(join(ctx.repoRoot, 'domain-packs', config.domainPack, 'rules.yaml')) ? loadDomainPack(ctx.repoRoot, config.domainPack) : undefined;
  const ui = uiFacts(ctx.states);
  const packMatches = pack ? matchTemplates(pack, bindings, ui) : [];
  const digest = buildDigest(ctx.model, ctx.entities, ctx.states);
  for (const m of packMatches) for (const e of m.evidence) if (!digest.some((d) => d.evidence.id === e.id)) digest.push({ evidence: e, text: `${e.kind} ${e.ref}` });
  const knownOps = new Set(ctx.model.operations.map((o) => o.key));
  const proposal = await proposeRules({ existing, packMatches, digest, knownOps, llm, ledger: ctx.ledger, runId: ctx.runId });

  // Assertions for confirmed rules (seed rules start confirmed; others after the lead's review).
  const steward = new Steward(ctx.ledger, ctx.runId, 'pramaan:assertion-dry-run');
  const assertions = await proposeAssertions({
    rules: proposal.rules,
    dir: join(specDir, 'assertions'),
    bindings,
    templates: pack?.templates ?? [],
    knownOps,
    roles: ctx.readyRoles,
    llm,
    ledger: ctx.ledger,
    runId: ctx.runId,
    ...(ctx.net
      ? {
          dryRun: {
            http: ctx.net.http,
            apiOrigin: ctx.net.apiOrigin,
            headersFor: ctx.net.headersFor,
            runTag: ctx.runTag,
            onCreated: (r) => steward.recordCreated({ ...r, entity: bindings.find((b) => b.createOp === r.operation)?.entity.name ?? r.entity }),
          },
        }
      : {}),
  });
  if (ctx.net && steward.created.length > 0) {
    await steward.teardown({ http: ctx.net.http, baseUrl: ctx.net.apiOrigin, headersFor: ctx.net.headersFor, learned: ctx.net.learned });
  }
  saveRules(rulesPath, proposal.rules);
  return { proposal, assertions, llmRequests, rulesPath };
}

/** Crawl state captures (aria + route) for the digest. */
export function crawlUiStates(crawlDir: string, roles: readonly string[], normalizeRoute: (url: string) => string): UiState[] {
  const out: UiState[] = [];
  for (const role of roles) {
    const dir = join(crawlDir, role, 'states');
    if (!existsSync(dir)) continue;
    for (const key of readdirSync(dir).sort()) {
      try {
        out.push({
          role,
          route: normalizeRoute(readFileSync(join(dir, key, 'url.txt'), 'utf8')),
          aria: readFileSync(join(dir, key, 'aria.yml'), 'utf8'),
          ref: `crawl/${role}/states/${key}`,
        });
      } catch {
        // incomplete capture: skip
      }
    }
  }
  return out;
}

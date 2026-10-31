// `pramaan authz` (§8 M4): differential replay of every observed operation as every other actor, anonymous and
// other-tenant; GETs replay the owner's exact request, mutations only target records this run created.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { createHttp } from '../core/net.js';
import { decideOwnership } from '../core/ownership-guard.js';
import { workspaceDir } from '../core/paths.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { newRunId, runTag } from '../core/run-id.js';
import { Finding, type MatrixRow as MatrixRowSchema } from '../core/schemas.js';
import { sha1 } from '../core/stable-json.js';
import { createTargetGuard } from '../core/target-guard.js';
import { Steward } from '../data/steward.js';
import { networkAllowed } from '../onboarding/contract.js';
import { ensureRoleSessions } from '../onboarding/ready.js';
import { loadAuthMaterial } from '../onboarding/sessions.js';
import { EntitiesFile, type Entity } from '../spec/entities.js';
import { buildApiModel, type ObservedOperation } from '../spec/har-to-openapi.js';
import { collectObservations } from '../spec/infer.js';
import { pathTo, retag } from '../spec/lifecycle-probe.js';
import { parseJsonMaybe, type Observation } from '../spec/observations.js';
import { recordsIn } from '../spec/state-machines.js';
import { classify } from './compare.js';
import { contradictions, loadMatrix, mergeMatrix, saveMatrix, type Contradiction, type RoleMatrix } from './matrix-io.js';
import { proposeCell, type ActorInfo } from './propose.js';

export interface AuthzOptions {
  appId: string;
  stateRoot: string;
  target?: 'staging' | undefined;
  env?: NodeJS.ProcessEnv;
}
export interface AuthzResult {
  runId: string;
  exitCode: 0 | 2;
  matrix: RoleMatrix;
  matrixPath: string;
  findings: z.infer<typeof Finding>[];
  questions: Contradiction[];
  skippedCells: { operation: string; actor: string; reason: string }[];
  summary: string;
}

type Row = z.infer<typeof MatrixRowSchema>;
type Cell = Row['observed'][string];
const ACTOR = 'pramaan:authz';
const LOGIN = /(login|logout|signin|signout|sign-in|sign-out|auth\/token|session)/i;
const CrawlSummary = z.object({ learnedTeardown: z.record(z.string(), z.string()).default({}) }).loose();

interface Replayed {
  actor: string;
  method: string;
  url: string;
  status: number;
  body: unknown;
}

export async function runAuthz(opts: AuthzOptions): Promise<AuthzResult> {
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  const { config } = loaded;
  const runId = newRunId();
  const specDir = workspaceDir(opts.stateRoot, config.id, 'spec');
  const matrixPath = join(specDir, 'role-matrix.yaml');
  const empty = (summary: string): AuthzResult => ({
    runId, exitCode: 2, matrix: loadMatrix(matrixPath), matrixPath, findings: [], questions: [], skippedCells: [], summary,
  });
  const head = `pramaan authz — app ${config.id} · run ${runId}`;
  if (!networkAllowed(loaded, opts.target)) return empty(`${head}\n  no network calls made: ${config.id} needs --target staging`);
  const entitiesPath = join(specDir, 'entities.yaml');
  if (!existsSync(entitiesPath)) return empty(`${head}\n  no Living Spec yet: run \`pramaan infer --app ${config.id}\` first`);

  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  ledger.append({ runId, type: 'run.started', actor: ACTOR, data: { command: 'authz' } });
  const guard = createTargetGuard(config.safety);
  const http = createHttp({ guard, limiter: createRateLimiter(config.safety.maxReplayRps), timeoutMs: 15_000 });
  const { ready } = await ensureRoleSessions(loaded, { stateRoot: opts.stateRoot, http, guard });
  const tenantOf = new Map(ready.map((r) => [r.role, r.tenant]));
  const headersFor = (role: string): Record<string, string> | undefined => loadAuthMaterial(opts.stateRoot, config.id, role)?.headers;
  const apiOrigin = new URL(config.apiBaseUrl ?? config.baseUrl).origin;
  const tag = runTag(config.safety.runTagPrefix, runId);

  const { observations } = collectObservations(opts.stateRoot, config);
  const model = buildApiModel(observations);
  const entities = EntitiesFile.parse(parseYaml(readFileSync(entitiesPath, 'utf8'))).entities;
  const crawlSummaryPath = workspaceDir(opts.stateRoot, config.id, 'crawl', 'crawl-summary.json');
  const learned = new Map<string, string>(
    Object.entries(existsSync(crawlSummaryPath) ? CrawlSummary.parse(JSON.parse(readFileSync(crawlSummaryPath, 'utf8'))).learnedTeardown : {}),
  );
  const steward = new Steward(ledger, runId, ACTOR);
  const replays: Replayed[] = [];
  const skippedCells: AuthzResult['skippedCells'] = [];

  const send = async (actor: string, role: string | undefined, method: string, url: string, body?: unknown): Promise<{ cell: Cell; res: Replayed }> => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (method !== 'GET') {
      const d = decideOwnership({ method, url, body: text ?? null, isLoginCall: false, createAllowed: false, ownedIds: steward.ownedIds() });
      if (!d.allow) throw new Error(`ownership guard: ${d.reason}`);
    }
    const headers = { ...(role ? (headersFor(role) ?? {}) : {}), ...(text ? { 'content-type': 'application/json' } : {}) };
    const r = await http.request(url, { method, headers, ...(text ? { body: text } : {}) });
    const res: Replayed = { actor, method, url, status: r.status, body: parseJsonMaybe(await r.text(), r.headers.get('content-type') ?? undefined) };
    replays.push(res);
    return { cell: { status: r.status, outcome: 'skipped', evidenceRef: `replay/authz-${runId}.json#${replays.length - 1}` }, res };
  };

  /** Every other actor relative to the owner: same-tenant roles, other-tenant roles, anonymous. */
  const actorsFor = (owner: string): ActorInfo[] => {
    const ownerTenant = tenantOf.get(owner);
    return [
      ...ready.filter((r) => r.role !== owner).map((r) => (r.tenant === ownerTenant ? { key: r.role, role: r.role } : { key: `other-tenant:${r.role}`, role: r.role })),
      { key: 'anonymous' },
    ];
  };

  // Records for mutation replays: created from crawl recipes, driven to the state the operation needs.
  const recipeFor = (e: Entity): { role: string; body: unknown } | undefined => {
    const create = model.operations.find((o) => o.key === e.createOp);
    const ok = create?.observations.find((o) => o.status >= 200 && o.status < 300 && o.reqBody !== undefined && tenantOf.get(o.role) === config.tenants[0]?.id);
    return ok ? { role: ok.role, body: ok.reqBody } : undefined;
  };
  const freshRecord = async (e: Entity, fromState: string): Promise<string | undefined> => {
    const sm = e.stateMachine;
    const recipe = recipeFor(e);
    if (!sm || !recipe) return undefined;
    const path = pathTo(sm, sm.initial, fromState);
    if (!path) return undefined;
    const r = await http.request(new URL(e.root, apiOrigin).toString(), {
      method: 'POST',
      headers: { ...(headersFor(recipe.role) ?? {}), 'content-type': 'application/json' },
      body: JSON.stringify(retag(recipe.body, config.safety.runTagPrefix, tag)),
    });
    const id = recordsIn(parseJsonMaybe(await r.text()))[0]?.[e.idField ?? 'id'];
    if (r.status < 200 || r.status >= 300 || (typeof id !== 'string' && typeof id !== 'number')) return undefined;
    steward.recordCreated({ entity: e.name, id: String(id), operation: e.createOp ?? `POST ${e.root}`, role: recipe.role });
    for (const step of path) {
      const [m = 'POST', tpl = ''] = step.op.split(' ');
      const actor = step.actors.find((a) => tenantOf.has(a)) ?? recipe.role;
      const s = await send(actor, actor, m, new URL(tpl.replace('{id}', encodeURIComponent(String(id))), apiOrigin).toString());
      if (s.res.status < 200 || s.res.status >= 300) return undefined;
    }
    return String(id);
  };

  const rows: Row[] = [];
  for (const op of model.operations) {
    if (LOGIN.test(op.path)) continue;
    for (const variant of variantsOf(op)) {
      const operation = variant.queryKeys.length > 0 ? `${op.key}?${variant.queryKeys.join('&')}` : op.key;
      const record = op.path.includes('{');
      const baseline = variant.observations.find((o) => o.status >= 200 && o.status < 300 && tenantOf.has(o.role));
      if (!baseline) {
        rows.push({ operation, ownerRole: variant.observations[0]?.role ?? ready[0]?.role ?? 'unknown', expected: {}, observed: {}, status: 'proposed' });
        continue;
      }
      const owner = baseline.role;
      const ctx = { method: op.method, path: op.path, ownerRole: owner, record };
      const expected: Row['expected'] = {};
      const observed: Row['observed'] = {};
      for (const actor of actorsFor(owner)) {
        expected[actor.key] = proposeCell(ctx, actor);
        if (op.method === 'GET') {
          const { cell, res } = await send(actor.key, actor.role, 'GET', baseline.url);
          observed[actor.key] = { ...cell, ...classify(res, baseline.resBody, { mutating: false, collection: !record }) };
          continue;
        }
        // Mutations: only on a fresh record this run created, in a state where the owner's call was legal.
        const entity = entities.find((e) => e.operations.includes(op.key));
        const from = entity?.stateMachine?.transitions.find((t) => t.op === op.key && t.observed)?.from;
        const id = entity && from !== undefined && record ? await freshRecord(entity, from) : undefined;
        if (!entity || id === undefined) {
          const reason = !record ? 'create operations are not replayed' : 'no owned record could be prepared for this operation';
          observed[actor.key] = { status: 0, outcome: 'skipped' };
          skippedCells.push({ operation, actor: actor.key, reason });
          continue;
        }
        const url = new URL(op.path.replace('{id}', encodeURIComponent(id)), apiOrigin).toString();
        const { cell, res } = await send(actor.key, actor.role, op.method, url, baseline.reqBody);
        observed[actor.key] = { ...cell, ...classify(res, baseline.resBody, { mutating: true, collection: false }) };
      }
      rows.push({ operation, ownerRole: owner, expected, observed, status: 'proposed' });
    }
  }

  const teardown = steward.created.length > 0 ? await steward.teardown({ http, baseUrl: apiOrigin, headersFor, learned }) : undefined;
  mkdirSync(join(specDir, 'replay'), { recursive: true });
  writeFileSync(join(specDir, 'replay', `authz-${runId}.json`), JSON.stringify(replays, null, 2));
  const matrix = mergeMatrix(loadMatrix(matrixPath), { schemaVersion: 1, rows });
  saveMatrix(matrixPath, matrix);

  // Contradictions: confirmed rows → findings; proposed rows → questions for the lead.
  const all = contradictions(matrix);
  const questions = all.filter((c) => !c.confirmed);
  const findings = recordFindings(all.filter((c) => c.confirmed), { ledger, runId, stateRoot: opts.stateRoot, app: config.id });
  const qPath = join(specDir, 'authz-questions.md');
  writeFileSync(qPath, renderQuestions(questions));
  ledger.append({ runId, type: 'run.completed', actor: ACTOR, data: { command: 'authz', rows: rows.length, findings: findings.length, questions: questions.length } });

  const cells = rows.flatMap((r) => Object.values(r.observed));
  const count = (o: string): number => cells.filter((c) => c.outcome === o).length;
  const summary = [
    head,
    `  ${rows.length} matrix rows · ${cells.length} cells: denied ${count('denied')} · same-data ${count('same-data')} · different-data ${count('different-data')} · error ${count('error')} · skipped ${count('skipped')}`,
    `  rows: ${matrix.rows.filter((r) => r.status === 'confirmed').length} confirmed · ${matrix.rows.filter((r) => r.status === 'proposed').length} proposed`,
    `  findings (confirmed rows violated): ${findings.length}${findings.map((f) => `\n    ${f.id} ${f.severity} ${f.title}`).join('')}`,
    `  questions for the lead (proposed rows contradicted): ${questions.length} → ${qPath}`,
    ...(teardown ? [`  records created ${steward.created.length} · torn down ${teardown.deleted.length} · retired ${teardown.retired.length} · orphaned ${teardown.orphaned.length}`] : []),
    `  LLM requests: 0 (heuristic expectations) · matrix: ${matrixPath}`,
    `  needs the lead: review role-matrix.yaml and set status: confirmed on correct rows`,
  ].join('\n');
  return { runId, exitCode: 0, matrix, matrixPath, findings, questions, skippedCells, summary };
}

/** One matrix row per distinct set of query keys (e.g. GET /api/leaves and GET /api/leaves?all). */
function variantsOf(op: ObservedOperation): { queryKeys: string[]; observations: Observation[] }[] {
  const by = new Map<string, Observation[]>();
  for (const o of op.observations) {
    const k = o.query.join('&');
    by.set(k, [...(by.get(k) ?? []), o]);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, obs]) => ({ queryKeys: k === '' ? [] : k.split('&'), observations: obs }));
}

function recordFindings(
  confirmed: Contradiction[],
  ctx: { ledger: Ledger; runId: string; stateRoot: string; app: string },
): z.infer<typeof Finding>[] {
  const dir = workspaceDir(ctx.stateRoot, ctx.app, 'findings');
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).filter((f) => /^F-\d{4,}\.json$/.test(f)).map((f) => Finding.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  let next = existing.reduce((n, f) => Math.max(n, Number(f.id.slice(2))), 0) + 1;
  const out: z.infer<typeof Finding>[] = [];
  for (const c of confirmed) {
    const signature = sha1(`authz-matrix|${c.operation}|${c.actor}|${c.expected}|${c.outcome}`);
    const prior = existing.find((f) => f.signature === signature);
    const crossTenant = c.actor.startsWith('other-tenant:') || c.actor === 'anonymous';
    const finding: z.infer<typeof Finding> = prior
      ? { ...prior, lastSeenRunId: ctx.runId }
      : {
          id: `F-${String(next++).padStart(4, '0')}`,
          title: `${c.actor} got ${c.outcome} (HTTP ${c.status}) on ${c.operation}; the confirmed matrix expects ${c.expected}`,
          severity: crossTenant ? 'S1' : 'S2',
          oracle: 'authz-matrix',
          signature,
          evidence: [{ id: `E-${sha1(`${ctx.runId}|${c.evidenceRef ?? c.operation}|${c.actor}`).slice(0, 8)}`, kind: 'replay', ref: c.evidenceRef ?? c.operation }],
          reproSteps: [
            `Log in as the owner role and call ${c.operation} on one of its records (see role-matrix.yaml ownerRole).`,
            `Replay the same request as ${c.actor}.`,
            `Observed: HTTP ${c.status} → ${c.outcome}. Expected (confirmed matrix): ${c.expected}.`,
          ],
          status: 'queued', // auto-filing needs a precision record for the oracle class (§4.7)
          firstSeenRunId: ctx.runId,
          lastSeenRunId: ctx.runId,
        };
    writeFileSync(join(dir, `${finding.id}.json`), JSON.stringify(finding, null, 2));
    if (!prior) {
      ctx.ledger.append({ runId: ctx.runId, type: 'finding.created', actor: ACTOR, data: { findingId: finding.id, oracle: 'authz-matrix', operation: c.operation, actor: c.actor } });
      ctx.ledger.append({ runId: ctx.runId, type: 'finding.queued', actor: ACTOR, data: { findingId: finding.id } });
    }
    out.push(finding);
  }
  return out;
}

function renderQuestions(qs: Contradiction[]): string {
  if (qs.length === 0) return '# Authorization questions\n\nNone — no proposed row is contradicted by what was observed.\n';
  return [
    '# Authorization questions',
    '',
    'Each line is a proposed matrix cell that the replay contradicts. Either the app is wrong (confirm the row and',
    'it becomes a finding) or the proposal is wrong (edit the expectation in role-matrix.yaml, then confirm).',
    '',
    '| Operation | Actor | Proposed | Observed | HTTP | Evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    ...qs.map((q) => `| \`${q.operation}\` | ${q.actor} | ${q.expected} | ${q.outcome} | ${q.status} | ${q.evidenceRef ?? ''} |`),
    '',
  ].join('\n');
}

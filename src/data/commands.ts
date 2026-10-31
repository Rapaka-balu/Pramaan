// `pramaan seed`, `pramaan teardown --run <id>`, `pramaan orphans` (§8 M7).
import { existsSync, readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import { loadAppConfig, repoRoot, type LoadedConfig } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { createHttp, type Http } from '../core/net.js';
import { workspaceDir } from '../core/paths.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { newRunId, runTag } from '../core/run-id.js';
import { createTargetGuard } from '../core/target-guard.js';
import { runFaker } from '../crawler/form-fill.js';
import { networkAllowed } from '../onboarding/contract.js';
import { ensureRoleSessions } from '../onboarding/ready.js';
import { loadAuthMaterial } from '../onboarding/sessions.js';
import { bindEntity } from '../spec/domain-pack.js';
import { EntitiesFile, type Entity } from '../spec/entities.js';
import { buildApiModel } from '../spec/har-to-openapi.js';
import { collectObservations } from '../spec/infer.js';
import { parseJsonMaybe } from '../spec/observations.js';
import { recordsIn } from '../spec/state-machines.js';
import { buildBody, enInFactory } from './factories/en_IN.js';
import { findTagged, noteCleanupAsk, resolveTeardown, type OrphanReport, type TeardownPlan } from './orphans.js';
import { join } from 'node:path';
import { Steward, type TeardownResult } from './steward.js';

interface Ctx {
  loaded: LoadedConfig;
  ledger: Ledger;
  http: Http;
  apiOrigin: string;
  entities: Entity[];
  plans: Map<string, TeardownPlan>;
  roles: string[];
  headersFor: (role: string) => Record<string, string> | undefined;
}

async function context(appId: string, stateRoot: string, env?: NodeJS.ProcessEnv): Promise<Ctx | string> {
  const loaded = loadAppConfig(appId, env ? { root: repoRoot(), env } : { root: repoRoot() });
  const { config } = loaded;
  const entitiesPath = workspaceDir(stateRoot, config.id, 'spec', 'entities.yaml');
  if (!existsSync(entitiesPath)) return `no Living Spec yet: run \`pramaan crawl\` and \`pramaan infer --app ${config.id}\` first`;
  const entities = EntitiesFile.parse(parseYaml(readFileSync(entitiesPath, 'utf8'))).entities;
  const guard = createTargetGuard(config.safety);
  const http = createHttp({ guard, limiter: createRateLimiter(config.safety.maxRps), timeoutMs: 15_000 });
  const { ready } = await ensureRoleSessions(loaded, { stateRoot, http, guard });
  const plans = new Map<string, TeardownPlan>();
  for (const e of entities) {
    const p = resolveTeardown(e);
    if (p) plans.set(e.name, p);
  }
  return {
    loaded,
    ledger: new Ledger({ root: stateRoot, app: config.id }),
    http,
    apiOrigin: new URL(config.apiBaseUrl ?? config.baseUrl).origin,
    entities,
    plans,
    roles: ready.map((r) => r.role),
    headersFor: (role) => loadAuthMaterial(stateRoot, config.id, role)?.headers,
  };
}

const refused = (appId: string, cmd: string): string => `pramaan ${cmd} — no network calls made: ${appId} needs --target staging`;

export interface TeardownCommandResult {
  exitCode: 0 | 1 | 2;
  result?: TeardownResult;
  pending: number;
  summary: string;
}

/** Tears down what a run (e.g. one killed halfway) left behind, from the ledger alone. */
export async function runTeardown(opts: { appId: string; stateRoot: string; runId: string; target?: 'staging' | undefined; env?: NodeJS.ProcessEnv }): Promise<TeardownCommandResult> {
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  if (!networkAllowed(loaded, opts.target)) return { exitCode: 2, pending: 0, summary: refused(opts.appId, 'teardown') };
  const ctx = await context(opts.appId, opts.stateRoot, opts.env);
  if (typeof ctx === 'string') return { exitCode: 2, pending: 0, summary: `pramaan teardown — ${ctx}` };
  const pending = Steward.orphans(ctx.ledger.read(), opts.runId);
  if (pending.length === 0) return { exitCode: 0, pending: 0, summary: `pramaan teardown — run ${opts.runId}: nothing left to tear down` };
  // Records the interrupted run created; teardown events are appended under the same run id.
  const steward = new Steward(ctx.ledger, opts.runId, 'pramaan:teardown');
  const result = await steward.teardown({ http: ctx.http, baseUrl: ctx.apiOrigin, headersFor: ctx.headersFor, plans: ctx.plans }, pending);
  const known = result.orphaned.filter((o) => !o.reason.startsWith('no teardown operation'));
  for (const o of result.orphaned.filter((x) => x.reason.startsWith('no teardown operation'))) {
    noteCleanupAsk(join(repoRoot(), 'docs', 'NEEDS-BALU.md'), opts.appId, o.record.entity);
  }
  return {
    exitCode: known.length > 0 ? 1 : 0,
    result,
    pending: pending.length,
    summary: [
      `pramaan teardown — app ${opts.appId} · run ${opts.runId}`,
      `  ${pending.length} record(s) pending · torn down ${result.deleted.length} · retired ${result.retired.length} · orphaned ${result.orphaned.length}`,
      ...result.orphaned.map((o) => `  orphaned ${o.record.entity} ${o.record.id}: ${o.reason}`),
      ...(result.orphaned.some((o) => o.reason.startsWith('no teardown operation')) ? ['  needs the lead: ask the devs for a cleanup endpoint (see docs/NEEDS-BALU.md)'] : []),
    ].join('\n'),
  };
}

export interface OrphansCommandResult {
  exitCode: 0 | 1 | 2;
  report?: OrphanReport;
  summary: string;
}

/** Tagged records still live anywhere in the app (any run, or one run with --run). */
export async function runOrphans(opts: { appId: string; stateRoot: string; runId?: string; target?: 'staging' | undefined; env?: NodeJS.ProcessEnv }): Promise<OrphansCommandResult> {
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  if (!networkAllowed(loaded, opts.target)) return { exitCode: 2, summary: refused(opts.appId, 'orphans') };
  const ctx = await context(opts.appId, opts.stateRoot, opts.env);
  if (typeof ctx === 'string') return { exitCode: 2, summary: `pramaan orphans — ${ctx}` };
  const { config } = ctx.loaded;
  const report = await findTagged({
    http: ctx.http,
    apiOrigin: ctx.apiOrigin,
    headersFor: ctx.headersFor,
    roles: ctx.roles,
    entities: ctx.entities,
    tagPrefix: config.safety.runTagPrefix,
    ...(opts.runId ? { runTag: runTag(config.safety.runTagPrefix, opts.runId) } : {}),
  });
  return {
    exitCode: report.live.length > 0 ? 1 : 0,
    report,
    summary: [
      `pramaan orphans — app ${config.id}${opts.runId ? ` · run ${opts.runId}` : ''}`,
      `  live tagged records ${report.live.length} · retired ${report.retired.length}${report.unchecked.length > 0 ? ` · not checkable (no list endpoint): ${report.unchecked.join(', ')}` : ''}`,
      ...report.live.slice(0, 20).map((r) => `  live ${r.entity} ${r.id} (${r.status ?? 'no status'}) tagged ${r.tag}, seen by ${r.seenBy}`),
      ...(report.live.length > 0 ? ['  next: pramaan teardown --run <runId> for each tag above'] : []),
    ].join('\n'),
  };
}

export interface SeedResult {
  exitCode: 0 | 1 | 2;
  runId: string;
  created: string[];
  summary: string;
}

/** Creates tagged records through the observed create operation and the en_IN factory (tear down with --run). */
export async function runSeed(opts: { appId: string; stateRoot: string; entity: string; count: number; role?: string; target?: 'staging' | undefined; env?: NodeJS.ProcessEnv }): Promise<SeedResult> {
  const runId = newRunId();
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  if (!networkAllowed(loaded, opts.target)) return { exitCode: 2, runId, created: [], summary: refused(opts.appId, 'seed') };
  const ctx = await context(opts.appId, opts.stateRoot, opts.env);
  if (typeof ctx === 'string') return { exitCode: 2, runId, created: [], summary: `pramaan seed — ${ctx}` };
  const { config } = ctx.loaded;
  const entity = ctx.entities.find((e) => e.name === opts.entity);
  const model = buildApiModel(collectObservations(opts.stateRoot, config).observations);
  const binding = entity && bindEntity(entity, model, config.roles.map((r) => ({ role: r.id, tenant: r.tenant })), config.safety.runTagPrefix);
  if (!entity || !binding) return { exitCode: 2, runId, created: [], summary: `pramaan seed — no create operation known for entity "${opts.entity}"` };
  const role = opts.role ?? binding.creator;
  const headers = ctx.headersFor(role);
  if (!headers) return { exitCode: 2, runId, created: [], summary: `pramaan seed — no session for role ${role}` };
  const steward = new Steward(ctx.ledger, runId, 'pramaan:seed');
  const factory = enInFactory(runFaker(runId));
  const schema = model.operations.find((o) => o.key === binding.createOp)?.requestSchema;
  const tag = runTag(config.safety.runTagPrefix, runId);
  const created: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const body = buildBody(schema, binding.recipe, { factory, runTag: tag, tagPrefix: config.safety.runTagPrefix, dateOffset: 200 + i * 2 });
    const res = await ctx.http.request(new URL(binding.createPath, ctx.apiOrigin).toString(), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const id = recordsIn(parseJsonMaybe(await res.text()))[0]?.[entity.idField ?? 'id'];
    if (res.status >= 200 && res.status < 300 && (typeof id === 'string' || typeof id === 'number')) {
      steward.recordCreated({ entity: entity.name, id: String(id), operation: binding.createOp, role, ...(ctx.plans.get(entity.name) && !ctx.plans.get(entity.name)?.actor ? { teardownOp: ctx.plans.get(entity.name)?.op } : {}) });
      created.push(String(id));
    } else failures.push(`HTTP ${res.status}`);
  }
  return {
    exitCode: failures.length > 0 ? 1 : 0,
    runId,
    created,
    summary: [
      `pramaan seed — app ${config.id} · run ${runId}`,
      `  created ${created.length} ${entity.name}(s) as ${role}, tagged ${tag}${failures.length > 0 ? ` · failed ${failures.length}: ${failures.join(', ')}` : ''}`,
      `  clean up: pramaan teardown --app ${config.id} --run ${runId}`,
    ].join('\n'),
  };
}



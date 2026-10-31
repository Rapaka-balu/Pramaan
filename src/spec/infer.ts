// `pramaan infer` (§8 M3): crawl HARs → observed OpenAPI, entities, state machines; the lifecycle probe
// confirms multi-role transitions; HRMS docs are used for scoring only. Output: workspace/<app>/spec/.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { loadAppConfig, repoRoot } from '../core/config.js';
import type { AppConfig } from '../core/schemas.js';
import { Ledger } from '../core/ledger.js';
import { createHttp } from '../core/net.js';
import { workspaceDir } from '../core/paths.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { newRunId, runTag } from '../core/run-id.js';
import { createTargetGuard } from '../core/target-guard.js';
import { Candidate } from '../crawler/candidates.js';
import { normalizeRoute } from '../crawler/state-key.js';
import { networkAllowed } from '../onboarding/contract.js';
import { ensureRoleSessions } from '../onboarding/ready.js';
import { loadAuthMaterial } from '../onboarding/sessions.js';
import { inferEntities, type Entity } from './entities.js';
import { buildApiModel, toOpenApi } from './har-to-openapi.js';
import { runLifecycleProbe, type ProbeResult } from './lifecycle-probe.js';
import { apiMatcher, observationsFromHar, type Observation } from './observations.js';
import { docOperations, scoreAgainstDocs, specUrlFromDocsPage, type DocsScore } from './score-vs-docs.js';
import { inferStateMachine, recordsIn, uiHintsFrom, type UiHint } from './state-machines.js';

export interface InferOptions {
  appId: string;
  stateRoot: string;
  target?: 'staging' | undefined;
  probe?: boolean; // default true when the network is allowed
  env?: NodeJS.ProcessEnv;
}
export interface InferResult {
  runId: string;
  exitCode: 0 | 2;
  entities: Entity[];
  operations: string[];
  probe: Record<string, Omit<ProbeResult, 'observations'>>;
  docs?: DocsScore;
  specDir: string;
  summary: string;
}

const ACTOR = 'pramaan:infer';
const CrawlSummary = z.object({ learnedTeardown: z.record(z.string(), z.string()).default({}) }).loose();

function crawlStates(crawlDir: string, role: string): { role: string; route: string; aria: string; actions: string[]; ref: string }[] {
  const dir = join(crawlDir, role, 'states');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((key) => {
    const d = join(dir, key);
    try {
      const url = readFileSync(join(d, 'url.txt'), 'utf8');
      const route = normalizeRoute(url);
      const cands = z.array(Candidate.loose()).parse(JSON.parse(readFileSync(join(d, 'candidates.json'), 'utf8')));
      // Record actions only: buttons in a row, or on a record's own page; never navigation.
      const actions = cands
        .filter((c) => c.kind === 'button' && !c.landmark && (c.descriptor.scope !== undefined || route.includes('{id}')))
        .map((c) => c.name);
      return [{ role, route, aria: readFileSync(join(d, 'aria.yml'), 'utf8'), actions, ref: `crawl/${role}/states/${key}` }];
    } catch {
      return [];
    }
  });
}

/** Crawl HAR observations plus Pramaan's own replay observations (lifecycle probe), oldest first. */
export function collectObservations(stateRoot: string, config: AppConfig): { observations: Observation[]; roles: string[] } {
  const crawlDir = workspaceDir(stateRoot, config.id, 'crawl');
  const isApi = apiMatcher(config.apiBaseUrl, config.baseUrl);
  const roles = existsSync(crawlDir) ? readdirSync(crawlDir).filter((r) => existsSync(join(crawlDir, r, 'crawl.har'))).sort() : [];
  const observations = roles.flatMap((role) => observationsFromHar(join(crawlDir, role, 'crawl.har'), role, `crawl/${role}/crawl.har`, isApi));
  const replayDir = workspaceDir(stateRoot, config.id, 'spec', 'replay');
  if (existsSync(replayDir)) {
    for (const f of readdirSync(replayDir).filter((x) => x.startsWith('lifecycle-')).sort()) {
      observations.push(...ReplayFile.parse(JSON.parse(readFileSync(join(replayDir, f), 'utf8'))));
    }
  }
  return { observations: observations.sort((a, b) => a.ts - b.ts), roles };
}

const ReplayFile = z.array(
  z.object({ role: z.string(), method: z.string(), url: z.string(), path: z.string(), query: z.array(z.string()), status: z.number(), reqBody: z.unknown().optional(), resBody: z.unknown().optional(), location: z.string().optional(), ts: z.number(), ref: z.string() }),
).transform((xs) => xs as Observation[]);

export async function runInfer(opts: InferOptions): Promise<InferResult> {
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  const { config } = loaded;
  const runId = newRunId();
  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  ledger.append({ runId, type: 'run.started', actor: ACTOR, data: { command: 'infer' } });
  const crawlDir = workspaceDir(opts.stateRoot, config.id, 'crawl');
  const specDir = workspaceDir(opts.stateRoot, config.id, 'spec');
  mkdirSync(specDir, { recursive: true });
  const isApi = apiMatcher(config.apiBaseUrl, config.baseUrl);
  const apiPrefix = config.apiBaseUrl ? new URL(config.apiBaseUrl).pathname.replace(/\/$/, '') || '/' : '/api';
  const apiOrigin = new URL(config.apiBaseUrl ?? config.baseUrl).origin;

  // 1. Observations from every role's crawl HAR.
  const roleDirs = existsSync(crawlDir) ? readdirSync(crawlDir).filter((r) => existsSync(join(crawlDir, r, 'crawl.har'))).sort() : [];
  if (roleDirs.length === 0) {
    return { runId, exitCode: 2, entities: [], operations: [], probe: {}, specDir, summary: `pramaan infer — app ${config.id}\n  no crawl found: run \`pramaan crawl --app ${config.id}\` first` };
  }
  const observations: Observation[] = roleDirs.flatMap((role) => observationsFromHar(join(crawlDir, role, 'crawl.har'), role, `crawl/${role}/crawl.har`, isApi));
  const uiStates = roleDirs.flatMap((r) => crawlStates(crawlDir, r));
  const learned = new Map<string, string>(
    Object.entries(existsSync(join(crawlDir, 'crawl-summary.json')) ? CrawlSummary.parse(JSON.parse(readFileSync(join(crawlDir, 'crawl-summary.json'), 'utf8'))).learnedTeardown : {}),
  );

  const build = (obs: Observation[], missing: ReadonlySet<string> = new Set()): { entities: Entity[]; model: ReturnType<typeof buildApiModel>; hints: Map<string, UiHint[]> } => {
    const model = buildApiModel(obs);
    const hints = new Map<string, UiHint[]>();
    const entities = inferEntities(model, apiPrefix).map((e) => {
      const values = new Set<string>();
      for (const op of model.operations.filter((o) => e.operations.includes(o.key))) {
        for (const o of op.observations) for (const r of recordsIn(o.resBody)) for (const f of ['status', 'state', 'stage']) if (typeof r[f] === 'string') values.add(r[f]);
      }
      const h = uiHintsFrom(uiStates.filter((s) => s.route.startsWith(e.root.replace(apiPrefix, '') || '/')), values);
      hints.set(e.name, h);
      const sm = inferStateMachine(e, model, h, missing);
      return sm ? { ...e, stateMachine: sm } : e;
    });
    return { entities, model, hints };
  };
  let { entities, model } = build(observations);

  // 2. Lifecycle probe (network) on entities with a state machine and a create operation.
  const probe: InferResult['probe'] = {};
  const allowed = networkAllowed(loaded, opts.target);
  const notes: string[] = [];
  let docs: DocsScore | undefined;
  if (!allowed) notes.push(`lifecycle probe and docs scoring skipped: ${config.id} needs --target staging`);
  const guard = createTargetGuard(config.safety);
  const http = createHttp({ guard, limiter: createRateLimiter(config.safety.maxReplayRps), timeoutMs: 15_000 });
  if (allowed && opts.probe !== false) {
    const primary = config.tenants[0]?.id;
    const { ready } = await ensureRoleSessions(loaded, { stateRoot: opts.stateRoot, http, guard, tenants: primary ? [primary] : [] });
    const roles = ready.map((r) => r.role);
    const probeObs: Observation[] = [];
    const missing = new Set<string>();
    for (const e of entities) {
      const createOp = model.operations.find((o) => o.key === e.createOp);
      if (!e.stateMachine || !createOp) continue;
      const res = await runLifecycleProbe(e, e.stateMachine, createOp, {
        http,
        apiOrigin,
        headersFor: (role) => loadAuthMaterial(opts.stateRoot, config.id, role)?.headers,
        roles,
        ledger,
        runId,
        runTag: runTag(config.safety.runTagPrefix, runId),
        tagPrefix: config.safety.runTagPrefix,
        learnedTeardown: learned,
      });
      probeObs.push(...res.observations);
      for (const m of res.missingOps) missing.add(m);
      const { observations: _o, ...rest } = res;
      probe[e.name] = rest;
    }
    if (probeObs.length > 0) {
      const replayDir = join(specDir, 'replay');
      mkdirSync(replayDir, { recursive: true });
      writeFileSync(join(replayDir, `lifecycle-${runId}.json`), JSON.stringify(probeObs, null, 2));
      ({ entities, model } = build([...observations, ...probeObs], missing));
    }

    // 3. Docs scoring (never an inference input).
    if (config.apiDocsUrl) {
      try {
        const page = await http.request(config.apiDocsUrl);
        const specUrl = specUrlFromDocsPage(await page.text(), config.apiDocsUrl);
        const doc = (await (await http.request(specUrl)).json()) as unknown;
        docs = scoreAgainstDocs(model.operations.map((o) => o.key), docOperations(doc));
      } catch (err) {
        notes.push(`docs scoring failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 4. Write the Living Spec drafts.
  const openapi = toOpenApi(model, { title: config.name, serverUrl: apiOrigin });
  writeFileSync(join(specDir, 'openapi.observed.yaml'), toYaml(openapi, { sortMapEntries: false, lineWidth: 0 }));
  writeFileSync(join(specDir, 'entities.yaml'), toYaml({ schemaVersion: 1, entities }, { lineWidth: 0 }));
  if (docs) writeFileSync(join(specDir, 'docs-score.json'), JSON.stringify(docs, null, 2));
  ledger.append({ runId, type: 'run.completed', actor: ACTOR, data: { command: 'infer', operations: model.operations.length, entities: entities.length } });

  const smLine = (e: Entity): string => {
    const sm = e.stateMachine;
    if (!sm) return `  ${e.name.padEnd(16)} ${e.operations.length} ops`;
    const obs = sm.transitions.filter((t) => t.observed).length;
    return `  ${e.name.padEnd(16)} ${e.operations.length} ops · ${sm.field}: ${sm.states.join('/')} · transitions ${obs} observed, ${sm.transitions.length - obs} hypothesized`;
  };
  const probeLines = Object.entries(probe).map(
    ([name, p]) => `  probe ${name}: tried ${p.tried} · confirmed ${p.confirmed.map((c) => `${c.from}→${c.to} (${c.op.split('/').pop()}, ${c.actor})`).join(', ') || 'none'}` +
      (p.teardown ? ` · teardown ${p.teardown.deleted.length} deleted/${p.teardown.retired.length} retired/${p.teardown.orphaned.length} orphaned` : ''),
  );
  const summary = [
    `pramaan infer — app ${config.id} · run ${runId}`,
    `  ${model.operations.length} operations from ${observations.length} API calls (${roleDirs.length} roles) · ${entities.length} entities`,
    ...entities.map(smLine),
    ...probeLines,
    ...(docs ? [`  docs score: precision ${(docs.precision * 100).toFixed(0)}% · recall ${(docs.recall * 100).toFixed(0)}% (${docs.matched}/${docs.documented} documented ops seen)`] : []),
    ...notes.map((n) => `  ${n}`),
    `  LLM requests: 0 (entity names from path roots) · spec drafts: ${specDir}`,
    '  needs the lead: review entities.yaml state machines (hypothesized transitions are observed:false)',
  ].join('\n');
  return { runId, exitCode: 0, entities, operations: model.operations.map((o) => o.key), probe, ...(docs ? { docs } : {}), specDir, summary };
}

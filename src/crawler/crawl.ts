// `pramaan crawl` (§8 M2): ensure each role's session, BFS-crawl it, then tear down what the run created.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { createHttp } from '../core/net.js';
import { workspaceDir } from '../core/paths.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { newRunId, runTag } from '../core/run-id.js';
import type { AppConfig } from '../core/schemas.js';
import { createTargetGuard } from '../core/target-guard.js';
import { Steward, type TeardownResult } from '../data/steward.js';
import { checkRoles, networkAllowed } from '../onboarding/contract.js';
import { ensureSession, loadAuthMaterial, sessionFiles, type SessionDeps } from '../onboarding/sessions.js';
import { crawlRole, type RoleCrawlSummary } from './bfs.js';

export interface CrawlOptions {
  appId: string;
  stateRoot: string;
  target?: 'staging' | undefined;
  roles?: string[] | undefined;
  maxStates?: number | undefined;
  env?: NodeJS.ProcessEnv;
  /** Tests only: adjust the parsed config (e.g. drop a deny pattern to prove the network guard catches it). */
  adjustConfig?: (c: AppConfig) => AppConfig;
}
export interface CrawlResult {
  runId: string;
  exitCode: 0 | 1 | 2;
  roles: RoleCrawlSummary[];
  skippedRoles: { role: string; reason: string }[];
  teardown?: TeardownResult;
  summaryPath?: string;
  summary: string;
}

const ACTOR = 'pramaan:crawl';

export async function runCrawl(opts: CrawlOptions): Promise<CrawlResult> {
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  const { env } = loaded;
  const config = opts.adjustConfig ? opts.adjustConfig(loaded.config) : loaded.config;
  const runId = newRunId();
  const head = `pramaan crawl — app ${config.id} · run ${runId}`;
  if (!networkAllowed(loaded, opts.target)) {
    return {
      runId,
      exitCode: 2,
      roles: [],
      skippedRoles: [],
      summary: `${head}\n  no network calls made: ${config.id} needs --target staging`,
    };
  }

  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  ledger.append({ runId, type: 'run.started', actor: ACTOR, data: { command: 'crawl' } });
  const tag = runTag(config.safety.runTagPrefix, runId);
  const guard = createTargetGuard(config.safety);
  const limiter = createRateLimiter(config.safety.maxRps);
  const http = createHttp({ guard, limiter, timeoutMs: 15_000 });
  const steward = new Steward(ledger, runId);
  const learnedTeardown = new Map<string, string>();
  const primaryTenant = config.tenants[0]?.id;
  const wanted = (role: string): boolean => !opts.roles || opts.roles.includes(role);

  const results: RoleCrawlSummary[] = [];
  const skippedRoles: { role: string; reason: string }[] = [];
  const browser = await chromium.launch();
  let teardown: TeardownResult | undefined;
  try {
    for (const r of checkRoles(loaded).filter((x) => wanted(x.role))) {
      if (r.status !== 'ready') {
        skippedRoles.push({ role: r.role, reason: r.status === 'cannot-verify' ? `cannot verify: ${r.reason}` : r.reason });
        continue;
      }
      const role = config.roles.find((x) => x.id === r.role);
      const tenant = config.tenants.find((t) => t.id === r.tenant);
      if (!role || !tenant) continue;
      const deps: SessionDeps = {
        root: opts.stateRoot,
        config,
        browser,
        http,
        guard,
        limiter,
        onBlocked: (info) => ledger.append({ runId, type: 'safety.blocked', actor: ACTOR, data: { role: r.role, ...info } }),
      };
      const session = await ensureSession(deps, {
        role: r.role,
        tenantCode: env[tenant.codeEnv],
        username: env[role.usernameEnv] ?? '',
        password: env[role.passwordEnv] ?? '',
      }).catch((err: unknown) => ({ status: 'failed' as const, reason: (err as Error).message.split('\n')[0] ?? 'error' }));
      if (session.status === 'failed') {
        skippedRoles.push({ role: r.role, reason: `login failed: ${session.reason}` });
        continue;
      }
      const outDir = workspaceDir(opts.stateRoot, config.id, 'crawl', r.role);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      results.push(
        await crawlRole({
          browser,
          config,
          role: r.role,
          primaryTenant: r.tenant === primaryTenant,
          storageStatePath: sessionFiles(opts.stateRoot, config.id, r.role).state,
          outDir,
          runId,
          runTag: tag,
          ledger,
          steward,
          guard,
          limiter,
          learnedTeardown,
          ...(opts.maxStates !== undefined ? { maxStates: opts.maxStates } : {}),
        }),
      );
    }
  } finally {
    await browser.close();
  }

  if (steward.created.length > 0) {
    teardown = await steward.teardown({
      http,
      baseUrl: new URL(config.apiBaseUrl ?? config.baseUrl).origin,
      headersFor: (role) => loadAuthMaterial(opts.stateRoot, config.id, role)?.headers,
      learned: learnedTeardown,
    });
  }

  const dir = workspaceDir(opts.stateRoot, config.id, 'crawl');
  mkdirSync(dir, { recursive: true });
  const summaryPath = join(dir, 'crawl-summary.json');
  const overall = {
    runId,
    app: config.id,
    roles: results.map(({ transitions, ...rest }) => ({ ...rest, transitions: transitions.length })),
    skippedRoles,
    learnedTeardown: Object.fromEntries(learnedTeardown),
    teardown: teardown
      ? { deleted: teardown.deleted.length, retired: teardown.retired.length, orphaned: teardown.orphaned.map((o) => ({ ...o.record, reason: o.reason })) }
      : null,
  };
  writeFileSync(summaryPath, JSON.stringify(overall, null, 2));
  const failedRoles = skippedRoles.filter((s) => s.reason.startsWith('login failed') || !s.reason.startsWith('cannot verify'));
  ledger.append({
    runId,
    type: 'run.completed',
    actor: ACTOR,
    data: { command: 'crawl', ok: failedRoles.length === 0, roles: results.length, states: results.reduce((n, r) => n + r.states, 0) },
  });

  const approvals = [...new Set(results.flatMap((r) => r.needsApproval))];
  const lines = [
    head,
    ...results.map(
      (r) =>
        `  ${r.role.padEnd(14)} ${String(r.states).padStart(3)} states · ${r.routes.length} routes · ${r.transitions.length} transitions · ` +
        `blocked ui ${r.skippedBySafety.deny}/net ${r.networkBlocked} · owned ${r.skippedBySafety.owned} · forms ${r.formsSubmitted} · ` +
        `${(r.durationMs / 1000).toFixed(1)}s · ${r.stoppedBy}${r.staleStates > 0 ? ` · stale ${r.staleStates}` : ''}` +
        `${r.errors.length > 0 ? ` · errors ${r.errors.length}` : ''}`,
    ),
    ...skippedRoles.map((s) => `  ${s.role.padEnd(14)} skipped: ${s.reason}`),
    `  records created ${steward.created.length}` +
      (teardown ? ` · torn down ${teardown.deleted.length} · retired ${teardown.retired.length} · orphaned ${teardown.orphaned.length}` : ''),
    `  LLM requests: 0 (keyless mode; deterministic ordering and form data) · summary: ${summaryPath}`,
    ...(approvals.length > 0 ? [`  needs the lead: approval-gated actions skipped — ${approvals.join(', ')} (add to safety.approvedActions to allow)`] : []),
    ...(teardown && teardown.orphaned.length > 0 ? [`  needs the lead: ${teardown.orphaned.length} orphaned record(s), see summary`] : []),
  ];
  return {
    runId,
    exitCode: results.length === 0 ? 2 : failedRoles.length > 0 ? 1 : 0,
    roles: results,
    skippedRoles,
    ...(teardown ? { teardown } : {}),
    summaryPath,
    summary: lines.join('\n'),
  };
}

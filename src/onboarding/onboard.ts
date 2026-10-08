// `pramaan onboard` (§8 M1): contract check, per-role login, sessions, onboarding.md / cannot-proceed.md.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppConfig, repoRoot } from '../core/config.js';
import { Ledger } from '../core/ledger.js';
import { createHttp } from '../core/net.js';
import { workspaceDir } from '../core/paths.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { newRunId } from '../core/run-id.js';
import { createTargetGuard } from '../core/target-guard.js';
import { checkContract } from './contract.js';
import { blockingFailures, renderCannotProceed, renderOnboardingMd, type OnboardRow } from './report.js';
import { ensureSession, type SessionDeps } from './sessions.js';

export interface OnboardOptions {
  appId: string;
  stateRoot: string;
  target?: 'staging' | undefined;
  roles?: string[] | undefined;
  env?: NodeJS.ProcessEnv;
}
export interface OnboardResult {
  runId: string;
  exitCode: 0 | 2;
  rows: OnboardRow[];
  reportPath: string;
  cannotProceedPath?: string;
  blocked: number;
  summary: string;
}

export async function runOnboard(opts: OnboardOptions): Promise<OnboardResult> {
  const loaded = loadAppConfig(opts.appId, opts.env ? { root: repoRoot(), env: opts.env } : { root: repoRoot() });
  const { config, env } = loaded;
  const runId = newRunId();
  const ledger = new Ledger({ root: opts.stateRoot, app: config.id });
  ledger.append({ runId, type: 'run.started', actor: 'pramaan:onboard', data: { command: 'onboard' } });

  const guard = createTargetGuard(config.safety);
  const limiter = createRateLimiter(config.safety.maxRps);
  const http = createHttp({ guard, limiter, timeoutMs: 15_000 });
  const contract = await checkContract(loaded, { target: opts.target, http });

  const wanted = (role: string): boolean => !opts.roles || opts.roles.includes(role);
  const rows: OnboardRow[] = [];
  let blocked = 0;
  const originsDown = contract.origins.some((o) => o.status === 'unreachable');

  const browser = contract.networkAllowed && !originsDown ? await chromium.launch() : undefined;
  try {
    for (const r of contract.roles.filter((x) => wanted(x.role))) {
      const base = { role: r.role, tenant: r.tenant, optional: r.optional };
      if (!contract.networkAllowed) {
        rows.push({ ...base, status: 'skipped', reason: `${config.id} requires --target staging`, ms: 0 });
      } else if (originsDown) {
        rows.push({ ...base, status: 'failed', reason: 'target origin unreachable', ms: 0 });
      } else if (r.status === 'cannot-verify') {
        rows.push({ ...base, status: 'skipped', reason: `cannot verify: ${r.reason}`, ms: 0 });
      } else if (r.status === 'missing') {
        rows.push({ ...base, status: 'failed', reason: r.reason, ms: 0 });
      } else if (browser) {
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
          onBlocked: (info) => {
            blocked += 1;
            ledger.append({ runId, type: 'safety.blocked', actor: 'pramaan:onboard', data: { role: r.role, ...info } });
          },
        };
        const started = Date.now();
        const out = await ensureSession(deps, {
          role: r.role,
          tenantCode: env[tenant.codeEnv],
          username: env[role.usernameEnv] ?? '',
          password: env[role.passwordEnv] ?? '',
        }).catch((err: unknown) => ({ status: 'failed' as const, reason: (err as Error).message.split('\n')[0] ?? 'error' }));
        rows.push({
          ...base,
          status: out.status,
          reason: out.status === 'failed' ? out.reason : '',
          ms: Date.now() - started,
        });
      }
    }
  } finally {
    await browser?.close();
  }

  const dir = workspaceDir(opts.stateRoot, config.id);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, 'onboarding.md');
  writeFileSync(reportPath, renderOnboardingMd(config.id, runId, rows, contract.origins));
  const cannotPath = join(dir, 'cannot-proceed.md');
  const failures = blockingFailures(rows);
  const stop = failures.length > 0 || !contract.networkAllowed;
  if (failures.length > 0) writeFileSync(cannotPath, renderCannotProceed(config.id, failures, contract.origins));
  else if (existsSync(cannotPath)) rmSync(cannotPath);

  const count = (s: OnboardRow['status']): number => rows.filter((r) => r.status === s).length;
  ledger.append({
    runId,
    type: 'run.completed',
    actor: 'pramaan:onboard',
    data: { command: 'onboard', ok: !stop, loggedIn: count('ok'), reused: count('reused'), refreshed: count('refreshed'), failed: count('failed'), skipped: count('skipped'), blocked },
  });

  const summary = [
    `pramaan onboard — app ${config.id} · run ${runId}`,
    ...rows.map((r) => `  ${r.status.padEnd(9)} ${r.role.padEnd(16)} ${r.reason}`),
    `  logged in ${count('ok')} · reused ${count('reused')} · refreshed ${count('refreshed')} · failed ${count('failed')} · skipped ${count('skipped')} · safety.blocked ${blocked}`,
    `  LLM cost: $0.00 · report: ${reportPath}`,
    ...(failures.length > 0 ? [`  CANNOT PROCEED: ${cannotPath}`] : []),
    ...(!contract.networkAllowed ? [`  no network calls made: ${config.id} needs --target staging`] : []),
    ...(rows.some((r) => r.reason.startsWith('cannot verify')) ? ['  needs the lead: credentials for the "cannot verify" roles above'] : []),
  ].join('\n');

  return {
    runId,
    exitCode: stop ? 2 : 0,
    rows,
    reportPath,
    ...(failures.length > 0 ? { cannotProceedPath: cannotPath } : {}),
    blocked,
    summary,
  };
}

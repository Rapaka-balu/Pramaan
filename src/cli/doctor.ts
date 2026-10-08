// `pramaan doctor` — environment, browsers, env keys, reachability, LLM mode (§8 M0 item 7).
import { existsSync } from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';
import { loadAppConfig } from '../core/config.js';
import { createTargetGuard } from '../core/target-guard.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { createHttp } from '../core/net.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorReport {
  app: string;
  checks: Check[];
  ok: boolean;
  networkCalls: number;
}
export interface DoctorOptions {
  appId: string;
  root: string;
  target?: 'staging' | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  browserPaths?: () => Record<string, string>;
}

const LLM_MODES = ['live', 'record', 'replay', 'replay-or-off', 'off'] as const;

function defaultBrowserPaths(): Record<string, string> {
  return { chromium: chromium.executablePath(), firefox: firefox.executablePath(), webkit: webkit.executablePath() };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    status: major >= 20 ? 'pass' : 'fail',
    detail: `v${process.versions.node} (need ≥ 20)`,
  });

  const paths = (opts.browserPaths ?? defaultBrowserPaths)();
  const missingBrowsers = Object.entries(paths).filter(([, p]) => !existsSync(p)).map(([b]) => b);
  checks.push({
    name: 'browsers',
    status: missingBrowsers.length === 0 ? 'pass' : 'fail',
    detail:
      missingBrowsers.length === 0
        ? Object.keys(paths).join(', ')
        : `missing: ${missingBrowsers.join(', ')} — run: npx playwright install chromium firefox webkit`,
  });

  const loaded = loadAppConfig(opts.appId, opts.env ? { root: opts.root, env: opts.env } : { root: opts.root });
  const { config, env } = loaded;
  checks.push({ name: 'config', status: 'pass', detail: `apps/${config.id}/app.yaml parsed` });

  const required = loaded.missingEnv.filter((m) => !m.optional).map((m) => m.key);
  const optional = loaded.missingEnv.filter((m) => m.optional).map((m) => m.key);
  checks.push({
    name: 'env (required)',
    status: required.length === 0 ? 'pass' : 'fail',
    detail: required.length === 0 ? 'all present' : `missing: ${[...new Set(required)].join(', ')}`,
  });
  if (optional.length > 0) {
    checks.push({
      name: 'env (optional)',
      status: 'warn',
      detail: `missing (those roles will be "cannot verify"): ${[...new Set(optional)].join(', ')}`,
    });
  }

  let networkCalls = 0;
  if (config.safety.requireTargetFlag && opts.target !== 'staging') {
    checks.push({
      name: 'reachability',
      status: 'skip',
      detail: `${config.id} requires --target staging; no network calls made`,
    });
  } else {
    const guard = createTargetGuard(config.safety);
    const http = createHttp({
      guard,
      limiter: createRateLimiter(config.safety.maxRps),
      timeoutMs: 10_000,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    try {
      const res = await http.request(config.baseUrl, { method: 'GET', redirect: 'manual' });
      checks.push({
        name: 'reachability',
        status: res.status === 200 ? 'pass' : 'fail',
        detail: `GET ${config.baseUrl} → ${res.status}`,
      });
    } catch (err) {
      const hint = config.id === 'demo' ? ' (start it with: npm run demo)' : '';
      checks.push({
        name: 'reachability',
        status: 'fail',
        detail: `GET ${config.baseUrl} failed: ${(err as Error).message}${hint}`,
      });
    }
    networkCalls = http.calls;
  }

  const rawMode = env['PRAMAAN_LLM_MODE'] ?? 'replay-or-off';
  const mode = (LLM_MODES as readonly string[]).includes(rawMode) ? rawMode : undefined;
  if (!mode) {
    checks.push({ name: 'llm', status: 'fail', detail: `PRAMAAN_LLM_MODE=${rawMode} is not one of ${LLM_MODES.join('|')}` });
  } else if (mode === 'live' || mode === 'record') {
    const hasKey = Boolean(env['ANTHROPIC_API_KEY']);
    checks.push({
      name: 'llm',
      status: hasKey ? 'pass' : 'fail',
      detail: hasKey ? `mode ${mode}, API key present` : `mode ${mode} needs ANTHROPIC_API_KEY`,
    });
  } else {
    checks.push({ name: 'llm', status: 'pass', detail: `mode ${mode} (no API calls)` });
  }

  return { app: config.id, checks, ok: checks.every((c) => c.status !== 'fail'), networkCalls };
}

const ICON: Record<CheckStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

export function formatDoctor(r: DoctorReport): string {
  const lines = [`pramaan doctor — app: ${r.app}`, ''];
  for (const c of r.checks) lines.push(`  [${ICON[c.status]}] ${c.name.padEnd(16)} ${c.detail}`);
  lines.push('', `  network calls: ${r.networkCalls} · LLM cost: $0.00`);
  lines.push(`  result: ${r.ok ? 'PASS' : 'FAIL — fix the FAIL lines above'}`);
  return lines.join('\n');
}

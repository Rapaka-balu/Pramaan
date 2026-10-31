// Ensures a live session for every ready role (reusing stored sessions; logging in again when one expired).
import { chromium, type Browser } from '@playwright/test';
import type { LoadedConfig } from '../core/config.js';
import type { Http } from '../core/net.js';
import { createRateLimiter } from '../core/rate-limit.js';
import type { TargetGuard } from '../core/target-guard.js';
import { checkRoles } from './contract.js';
import { ensureSession, type SessionDeps } from './sessions.js';

export interface ReadyRole {
  role: string;
  tenant: string;
}

export async function ensureRoleSessions(
  loaded: LoadedConfig,
  opts: { stateRoot: string; http: Http; guard: TargetGuard; tenants?: readonly string[] },
): Promise<{ ready: ReadyRole[]; skipped: { role: string; reason: string }[] }> {
  const { config, env } = loaded;
  const ready: ReadyRole[] = [];
  const skipped: { role: string; reason: string }[] = [];
  let browser: Browser | undefined;
  try {
    for (const r of checkRoles(loaded)) {
      if (opts.tenants && !opts.tenants.includes(r.tenant)) continue;
      if (r.status !== 'ready') {
        skipped.push({ role: r.role, reason: r.status === 'cannot-verify' ? `cannot verify: ${r.reason}` : r.reason });
        continue;
      }
      const role = config.roles.find((x) => x.id === r.role);
      const tenant = config.tenants.find((t) => t.id === r.tenant);
      if (!role || !tenant) continue;
      browser ??= await chromium.launch();
      const deps: SessionDeps = {
        root: opts.stateRoot,
        config,
        browser,
        http: opts.http,
        guard: opts.guard,
        limiter: createRateLimiter(config.safety.maxRps),
        onBlocked: () => undefined,
      };
      const s = await ensureSession(deps, {
        role: r.role,
        tenantCode: env[tenant.codeEnv],
        username: env[role.usernameEnv] ?? '',
        password: env[role.passwordEnv] ?? '',
      }).catch((err: unknown) => ({ status: 'failed' as const, reason: (err as Error).message.split('\n')[0] ?? 'error' }));
      if (s.status === 'failed') skipped.push({ role: r.role, reason: `login failed: ${s.reason}` });
      else ready.push({ role: r.role, tenant: r.tenant });
    }
  } finally {
    await browser?.close();
  }
  return { ready, skipped };
}

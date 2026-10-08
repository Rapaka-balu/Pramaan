// Onboarding contract check (§8 M1): credentials per role, tenants resolve, origins reachable.
import type { LoadedConfig } from '../core/config.js';
import type { Http } from '../core/net.js';

export type RoleStatus = 'ready' | 'cannot-verify' | 'missing';
export interface RoleReadiness {
  role: string;
  tenant: string;
  optional: boolean;
  status: RoleStatus;
  reason: string;
}
export interface OriginCheck {
  url: string;
  status: 'ok' | 'unreachable' | 'skipped';
  detail: string;
}
export interface ContractResult {
  ok: boolean;
  networkAllowed: boolean;
  roles: RoleReadiness[];
  origins: OriginCheck[];
}

export function networkAllowed(loaded: LoadedConfig, target: string | undefined): boolean {
  return !loaded.config.safety.requireTargetFlag || target === 'staging';
}

export function checkRoles(loaded: LoadedConfig): RoleReadiness[] {
  const { config, env } = loaded;
  return config.roles.map((r) => {
    const tenant = config.tenants.find((t) => t.id === r.tenant);
    const missing: string[] = [];
    if (!tenant) missing.push(`tenant '${r.tenant}' not declared`);
    else if (!env[tenant.codeEnv]) missing.push(tenant.codeEnv);
    for (const key of [r.usernameEnv, r.passwordEnv, ...(r.totpSeedEnv ? [r.totpSeedEnv] : [])]) {
      if (!env[key]) missing.push(key);
    }
    if (missing.length === 0) return { role: r.id, tenant: r.tenant, optional: r.optional, status: 'ready', reason: '' };
    return {
      role: r.id,
      tenant: r.tenant,
      optional: r.optional,
      status: r.optional ? 'cannot-verify' : 'missing',
      reason: `missing ${missing.join(', ')}`,
    };
  });
}

export async function checkContract(
  loaded: LoadedConfig,
  opts: { target?: string | undefined; http: Http },
): Promise<ContractResult> {
  const roles = checkRoles(loaded);
  const allowed = networkAllowed(loaded, opts.target);
  const urls = [loaded.config.baseUrl, ...(loaded.config.apiBaseUrl ? [loaded.config.apiBaseUrl] : [])];
  const origins: OriginCheck[] = [];
  for (const url of urls) {
    if (!allowed) {
      origins.push({ url, status: 'skipped', detail: 'requires --target staging' });
      continue;
    }
    try {
      const res = await opts.http.request(url, { method: 'GET', redirect: 'manual' });
      // The UI root must answer cleanly; an API base only has to answer at all.
      const ok = url === loaded.config.baseUrl ? res.status < 400 : res.status < 500;
      origins.push({ url, status: ok ? 'ok' : 'unreachable', detail: `HTTP ${res.status}` });
    } catch (err) {
      origins.push({ url, status: 'unreachable', detail: (err as Error).message });
    }
  }
  const ok = allowed && roles.every((r) => r.status !== 'missing') && origins.every((o) => o.status === 'ok');
  return { ok, networkAllowed: allowed, roles, origins };
}

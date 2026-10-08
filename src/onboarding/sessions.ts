// Session store (§8 M1): storageState per role in workspace/<app>/sessions/, refreshed on a 401.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser } from '@playwright/test';
import { z } from 'zod';
import type { AppConfig } from '../core/schemas.js';
import type { Http } from '../core/net.js';
import { installOwnershipGuard } from '../core/ownership-guard.js';
import type { RateLimiter } from '../core/rate-limit.js';
import type { TargetGuard } from '../core/target-guard.js';
import { workspaceDir } from '../core/paths.js';
import {
  AuthScheme,
  buildAuthMaterial,
  deriveAuthScheme,
  LOGIN_PATH_RE,
  type AuthMaterial,
  type HarEntryLike,
  type StorageStateLike,
} from './auth-material.js';
import { loginWithForm } from './login-form.js';

export const SessionMeta = z.object({
  role: z.string(),
  origin: z.string(),
  scheme: AuthScheme,
  savedAt: z.string(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

export function sessionFiles(root: string, app: string, role: string): { state: string; meta: string; har: string } {
  const dir = workspaceDir(root, app, 'sessions');
  return { state: join(dir, `${role}.json`), meta: join(dir, `${role}.meta.json`), har: join(dir, `${role}.login.har`) };
}

const StorageState = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string() }).loose()),
  origins: z.array(
    z.object({ origin: z.string(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })) }),
  ),
});
const Har = z.object({
  log: z.object({
    entries: z.array(
      z.object({
        request: z.object({
          method: z.string(),
          url: z.string(),
          headers: z.array(z.object({ name: z.string(), value: z.string() })),
        }),
        response: z.object({ status: z.number() }),
      }),
    ),
  }),
});

const readJson = <T>(schema: z.ZodType<T>, path: string): T => schema.parse(JSON.parse(readFileSync(path, 'utf8')));

export function loadSession(root: string, app: string, role: string): { meta: SessionMeta; storage: StorageStateLike } | undefined {
  const f = sessionFiles(root, app, role);
  if (!existsSync(f.state) || !existsSync(f.meta)) return undefined;
  return { meta: readJson(SessionMeta, f.meta), storage: readJson(StorageState, f.state) };
}

/** AuthMaterial for API replay, built from the stored session. Undefined if the role never logged in. */
export function loadAuthMaterial(root: string, app: string, role: string): AuthMaterial | undefined {
  const s = loadSession(root, app, role);
  return s ? buildAuthMaterial(s.meta.scheme, s.storage, s.meta.origin) : undefined;
}

export interface RoleCredentials {
  role: string;
  tenantCode?: string | undefined;
  username: string;
  password: string;
}
export interface SessionDeps {
  root: string;
  config: AppConfig;
  browser: Browser;
  http: Http;
  guard: TargetGuard;
  limiter: RateLimiter;
  onBlocked: (info: { method: string; path: string; reason: string }) => void;
}
export type SessionOutcome =
  | { status: 'ok' | 'reused' | 'refreshed'; material: AuthMaterial }
  | { status: 'failed'; reason: string };

async function probe(deps: SessionDeps, meta: SessionMeta, material: AuthMaterial): Promise<number> {
  if (!meta.scheme.probe) return 0;
  const res = await deps.http.request(meta.scheme.probe.url, { method: 'GET', headers: material.headers });
  return res.status;
}

/** Logs in through the browser, saves storageState + derived auth scheme, then proves the API accepts it. */
export async function loginAndSave(deps: SessionDeps, creds: RoleCredentials): Promise<SessionOutcome> {
  const f = sessionFiles(deps.root, deps.config.id, creds.role);
  mkdirSync(dirname(f.state), { recursive: true });
  const origin = new URL(deps.config.baseUrl).origin;
  const context = await deps.browser.newContext({ recordHar: { path: f.har, mode: 'full', content: 'omit' } });
  let result;
  try {
    await installOwnershipGuard(context, {
      guard: deps.guard,
      limiter: deps.limiter,
      getOwnedIds: () => new Set<string>(),
      createAllowed: () => false,
      isLoginUrl: (url) => LOGIN_PATH_RE.test(new URL(url).pathname),
      onBlocked: deps.onBlocked,
    });
    const page = await context.newPage();
    result = await loginWithForm(page, {
      loginUrl: new URL(deps.config.login.url, deps.config.baseUrl).toString(),
      fields: deps.config.login.fields,
      successSignal: deps.config.login.successSignal,
      tenantCode: creds.tenantCode,
      username: creds.username,
      password: creds.password,
    });
    if (result.ok) await context.storageState({ path: f.state });
  } finally {
    await context.close(); // flushes the HAR
  }
  if (!result.ok) return { status: 'failed', reason: result.error ?? 'login failed' };

  const storage = readJson(StorageState, f.state);
  const har = readJson(Har, f.har);
  const scheme = deriveAuthScheme(har.log.entries satisfies HarEntryLike[], storage, {
    apiBaseUrl: deps.config.apiBaseUrl,
  });
  if (!scheme.bearer) return { status: 'failed', reason: 'logged in, but could not derive how the API authenticates' };
  const meta: SessionMeta = { role: creds.role, origin, scheme, savedAt: new Date().toISOString() };
  writeFileSync(f.meta, JSON.stringify(meta, null, 2));

  const material = buildAuthMaterial(scheme, storage, origin);
  const status = await probe(deps, meta, material);
  if (status < 200 || status >= 300) {
    return { status: 'failed', reason: `derived API auth rejected: GET ${scheme.probe?.url ?? '(no probe)'} → ${status}` };
  }
  return { status: 'ok', material };
}

/** Reuses a stored session when its first API call succeeds; logs in again on 401/403 or a missing session. */
export async function ensureSession(deps: SessionDeps, creds: RoleCredentials): Promise<SessionOutcome> {
  const stored = loadSession(deps.root, deps.config.id, creds.role);
  if (stored?.meta.scheme.probe) {
    const material = buildAuthMaterial(stored.meta.scheme, stored.storage, stored.meta.origin);
    const status = await probe(deps, stored.meta, material);
    if (status >= 200 && status < 300) return { status: 'reused', material };
    if (status !== 401 && status !== 403) {
      return { status: 'failed', reason: `stored session probe returned HTTP ${status}` };
    }
    const fresh = await loginAndSave(deps, creds);
    return fresh.status === 'ok' ? { status: 'refreshed', material: fresh.material } : fresh;
  }
  return loginAndSave(deps, creds);
}

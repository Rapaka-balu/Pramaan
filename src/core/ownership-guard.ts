// Network ownership guard (§2.3 #9): non-GET requests only for creates, owned IDs, or login.
import type { BrowserContext, Route } from '@playwright/test';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const HEX24 = /^[0-9a-f]{24}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ID_KEY = /^(id|ids)$|_ids?$|[a-z0-9]Ids?$/;

export function isIdLikeSegment(seg: string): boolean {
  return /^\d+$/.test(seg) || UUID.test(seg) || ULID.test(seg) || HEX24.test(seg);
}

function collectIds(v: unknown, out: Set<string>, keyIsId = false): void {
  if (Array.isArray(v)) {
    for (const x of v) collectIds(x, out, keyIsId);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) collectIds(x, out, ID_KEY.test(k));
  } else if (keyIsId && (typeof v === 'string' || typeof v === 'number')) {
    out.add(String(v));
  }
}

/** id / *_id / *Id values from a JSON or form-encoded body and the query string. `primary` = top-level id/ids. */
function targetedIds(u: URL, body: string | null | undefined): { all: Set<string>; primary: Set<string> } {
  const all = new Set<string>();
  const primary = new Set<string>();
  const top = (k: string, v: unknown): void => {
    if (/^ids?$/.test(k)) collectIds(v, primary, true);
  };
  for (const [k, v] of u.searchParams) {
    if (ID_KEY.test(k)) all.add(v);
    top(k, v);
  }
  if (body) {
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      isJson = false;
    }
    if (isJson) {
      collectIds(parsed, all);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) top(k, v);
      }
    } else {
      for (const [k, v] of new URLSearchParams(body)) {
        if (ID_KEY.test(k)) all.add(v);
        top(k, v);
      }
    }
  }
  return { all, primary };
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export interface OwnershipRequest {
  method: string;
  url: string;
  body?: string | null;
  isLoginCall: boolean;
  createAllowed: boolean;
  ownedIds: ReadonlySet<string>;
}

export function decideOwnership(req: OwnershipRequest): { allow: boolean; reason: string } {
  const method = req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { allow: true, reason: 'safe method' };
  if (req.isLoginCall) return { allow: true, reason: 'login call' };

  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { allow: false, reason: `malformed URL: ${req.url}` };
  }
  const pathIds = u.pathname.split('/').filter(Boolean).map(decode).filter(isIdLikeSegment);

  // A path that names records is judged by the path alone: some named ID must be ours.
  if (pathIds.length > 0) {
    const owned = pathIds.find((id) => req.ownedIds.has(id));
    return owned !== undefined
      ? { allow: true, reason: `targets owned id ${owned}` }
      : { allow: false, reason: `${method} targets id ${pathIds.join(',')} not created by this run` };
  }

  const { all, primary } = targetedIds(u, req.body);
  const ownedBodyId = [...all].find((id) => req.ownedIds.has(id));
  if (ownedBodyId !== undefined) return { allow: true, reason: `body targets owned id ${ownedBodyId}` };
  // A top-level `id` names the record being changed; foreign keys (leaveTypeId, ...) are normal in a create.
  if (primary.size > 0) {
    return { allow: false, reason: `${method} targets id ${[...primary].join(',')} not created by this run` };
  }
  if (method === 'POST') {
    return req.createAllowed
      ? { allow: true, reason: 'create (POST without id)' }
      : { allow: false, reason: 'create not allowed from this context' };
  }
  return { allow: false, reason: `${method} without an owned target id` };
}

export interface OwnershipGuardOptions {
  getOwnedIds: () => ReadonlySet<string>;
  isLoginUrl: (url: string) => boolean;
  createAllowed: () => boolean;
  onBlocked: (info: { method: string; path: string; reason: string }) => void;
  guard?: { check(url: string): { ok: boolean; reason?: string } };
  limiter?: { acquire(): Promise<void> };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export async function installOwnershipGuard(context: BrowserContext, opts: OwnershipGuardOptions): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    // data:/blob: URLs never leave the browser.
    if (/^(data|blob|about):/i.test(url)) return route.continue();

    if (opts.guard) {
      const g = opts.guard.check(url);
      if (!g.ok) {
        opts.onBlocked({ method, path: pathOf(url), reason: g.reason ?? 'target guard refused' });
        return route.abort('blockedbyclient');
      }
    }
    if (opts.limiter) await opts.limiter.acquire();

    const d = decideOwnership({
      method,
      url,
      body: req.postData(),
      isLoginCall: opts.isLoginUrl(url),
      createAllowed: opts.createAllowed(),
      ownedIds: opts.getOwnedIds(),
    });
    if (!d.allow) {
      opts.onBlocked({ method, path: pathOf(url), reason: d.reason });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

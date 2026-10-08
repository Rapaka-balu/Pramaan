// Works out how the API authenticates from the login run's HAR + storage state (§8 M1).
// Raw tokens never leave workspace/: the scheme stores only *where* the token lives.
import { z } from 'zod';

export interface HarHeader {
  name: string;
  value: string;
}
export interface HarEntryLike {
  request: { method: string; url: string; headers: HarHeader[] };
  response: { status: number };
}
export interface StorageStateLike {
  cookies: { name: string; value: string; domain: string; path: string }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export const AuthScheme = z.object({
  bearer: z
    .discriminatedUnion('source', [
      z.object({ source: z.literal('localStorage'), key: z.string(), header: z.string(), prefix: z.string() }),
      z.object({ source: z.literal('cookie'), names: z.array(z.string()).min(1) }),
    ])
    .optional(),
  tenantHeader: z.object({ name: z.string(), value: z.string() }).optional(),
  probe: z.object({ method: z.literal('GET'), url: z.string() }).optional(),
});
export type AuthScheme = z.infer<typeof AuthScheme>;

export interface AuthMaterial {
  headers: Record<string, string>;
  cookies: StorageStateLike['cookies'];
}

// Headers every browser sends; anything else present on every API call is app-specific.
const STANDARD_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'authorization', 'cache-control', 'connection',
  'content-length', 'content-type', 'cookie', 'host', 'origin', 'pragma', 'referer', 'user-agent',
  'if-none-match', 'if-modified-since', 'dnt', 'priority', 'x-requested-with',
]);
const isStandard = (name: string): boolean => STANDARD_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith(':');

const lower = (hs: HarHeader[]): Map<string, string> => new Map(hs.map((h) => [h.name.toLowerCase(), h.value]));

export function isApiUrl(url: string, apiBase: string | undefined): boolean {
  if (apiBase && url.startsWith(apiBase.replace(/\/+$/, ''))) return true;
  try {
    return /^\/api(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export const LOGIN_PATH_RE = /(login|signin|sign-in|authenticate|auth\/token|oauth\/token|session)/i;

export function deriveAuthScheme(
  entries: readonly HarEntryLike[],
  storage: StorageStateLike,
  opts: { apiBaseUrl?: string | undefined } = {},
): AuthScheme {
  const api = entries.filter((e) => isApiUrl(e.request.url, opts.apiBaseUrl));
  const authed = api.filter((e) => !LOGIN_PATH_RE.test(new URL(e.request.url).pathname));
  if (authed.length === 0) return {};
  const headerMaps = authed.map((e) => lower(e.request.headers));

  const scheme: AuthScheme = {};

  // Bearer: an Authorization header on every authenticated call, whose token sits in localStorage.
  const authValues = headerMaps.map((m) => m.get('authorization'));
  if (authValues.every((v): v is string => Boolean(v))) {
    const last = authValues[authValues.length - 1] ?? '';
    const match = /^(\S+\s+)?(.+)$/.exec(last);
    const prefix = match?.[1] ?? '';
    const token = match?.[2] ?? last;
    for (const o of storage.origins) {
      const hit = o.localStorage.find((kv) => kv.value === token || kv.value === JSON.stringify(token));
      if (hit) {
        scheme.bearer = { source: 'localStorage', key: hit.name, header: 'Authorization', prefix };
        break;
      }
    }
  } else if (headerMaps.every((m) => m.has('cookie'))) {
    const names = new Set<string>();
    for (const m of headerMaps) for (const part of (m.get('cookie') ?? '').split(';')) {
      const n = part.split('=')[0]?.trim();
      if (n) names.add(n);
    }
    if (names.size > 0) scheme.bearer = { source: 'cookie', names: [...names].sort() };
  }

  // Tenant header: a non-standard header present on EVERY API call with a constant value.
  const first = headerMaps[0];
  if (first) {
    const candidates = [...first.keys()].filter(
      (name) => !isStandard(name) && headerMaps.every((m) => m.get(name) === first.get(name)),
    );
    const name = candidates.find((n) => /tenant/i.test(n)) ?? candidates.find((n) => /org|company|client/i.test(n));
    if (name) {
      const original = authed[0]?.request.headers.find((h) => h.name.toLowerCase() === name)?.name ?? name;
      scheme.tenantHeader = { name: original, value: first.get(name) ?? '' };
    }
  }

  // Prefer an identity endpoint as the probe: it is cheap and rarely data-dependent.
  const okGets = authed.filter((e) => e.request.method === 'GET' && e.response.status >= 200 && e.response.status < 300);
  const probe =
    okGets.find((e) => /\/(me|whoami|profile|current-?user|session|user)\/?$/i.test(new URL(e.request.url).pathname)) ??
    okGets[0];
  if (probe) scheme.probe = { method: 'GET', url: probe.request.url };
  return scheme;
}

/** Builds request headers/cookies for API replay from a stored session. Missing token ⇒ no auth header. */
export function buildAuthMaterial(scheme: AuthScheme, storage: StorageStateLike, origin: string): AuthMaterial {
  const headers: Record<string, string> = {};
  let cookies: AuthMaterial['cookies'] = [];
  const b = scheme.bearer;
  if (b?.source === 'localStorage') {
    const ls = storage.origins.find((o) => o.origin === origin) ?? storage.origins[0];
    const raw = ls?.localStorage.find((kv) => kv.name === b.key)?.value;
    if (raw) {
      const token = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
      headers[b.header] = `${b.prefix}${token}`;
    }
  } else if (b?.source === 'cookie') {
    cookies = storage.cookies.filter((c) => b.names.includes(c.name));
    if (cookies.length > 0) headers['Cookie'] = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  if (scheme.tenantHeader) headers[scheme.tenantHeader.name] = scheme.tenantHeader.value;
  return { headers, cookies };
}

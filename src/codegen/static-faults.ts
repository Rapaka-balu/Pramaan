// The suite's fault hook (§8 M8): `pramaan mutate` sets PRAMAAN_FAULT and the suite corrupts matching responses —
// in `call()` for API traffic and through `context.route` for browser traffic (route does not see APIRequestContext).
// Without PRAMAAN_FAULT the hook is inert.

export const FAULTS_TS = `/** PRAMAAN_FAULT="<kind>:<METHOD> <path-template>[#field]", set only by \`pramaan mutate\`. */
export interface FaultSpec {
  kind: string;
  method: string;
  path: string;
  field?: string;
  channel?: 'ui';
}
export interface Response {
  status: number;
  body: unknown;
}

export function activeFault(): FaultSpec | undefined {
  const raw = process.env['PRAMAAN_FAULT'];
  if (!raw) return undefined;
  const m = /^([a-z0-9-]+):([A-Z]+) ([^#@]+?)(?:#([^@]+))?(?:@(ui))?$/.exec(raw.trim());
  if (!m || !m[1] || !m[2] || !m[3]) throw new Error('bad PRAMAAN_FAULT: ' + raw);
  return { kind: m[1], method: m[2], path: m[3], ...(m[4] ? { field: m[4] } : {}), ...(m[5] === 'ui' ? { channel: 'ui' as const } : {}) };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&');

export function matches(f: FaultSpec, method: string, url: string): boolean {
  if (f.method !== method.toUpperCase()) return false;
  const path = new URL(url, 'http://suite.invalid').pathname;
  const template = f.path.split('?')[0] ?? f.path;
  const re = new RegExp('^' + template.split(/\\{[^}]+\\}/).map(escapeRe).join('[^/]+') + '$');
  return re.test(path);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const OWNER_KEY = /^(tenant|tenantId|tenant_id|employeeId|employee_id|ownerId|owner_id|userId|user_id)$/;

// Per-worker memory the stateful faults need.
const lastOk = new Map<string, unknown>(); // op → last 2xx body (status-403-to-200 replays it)
const beforeMutation = new Map<string, unknown>(); // op → body seen before the latest write (stale-copy)
const lastGet = new Map<string, unknown>();
const seenOwners = new Map<string, Set<string>>(); // owner key → values seen (swap-tenant-id)

function eachRecord(body: unknown, fn: (r: Record<string, unknown>) => void): void {
  if (Array.isArray(body)) body.filter(isObj).forEach(fn);
  else if (isObj(body)) fn(body);
}

function corrupt(f: FaultSpec, body: unknown): unknown {
  const copy = structuredClone(body);
  const field = f.field;
  switch (f.kind) {
    case 'empty-list':
      return Array.isArray(copy) ? [] : copy;
    case 'truncate-list':
      return Array.isArray(copy) ? copy.slice(0, Math.max(0, copy.length - 1)) : copy;
    case 'swap-tenant-id':
      eachRecord(copy, (r) => {
        for (const k of Object.keys(r)) {
          if (!OWNER_KEY.test(k)) continue;
          const other = [...(seenOwners.get(k) ?? [])].find((v) => v !== String(r[k]));
          r[k] = other !== undefined ? (typeof r[k] === 'number' ? Number(other) : other) : typeof r[k] === 'number' ? Number(r[k]) + 1000 : 'OTHER';
        }
      });
      return copy;
  }
  if (!field) return copy;
  eachRecord(copy, (r) => {
    if (!(field in r)) return;
    const v = r[field];
    if (f.kind === 'drop-field') delete r[field];
    else if (f.kind === 'null-field') r[field] = null;
    else if (f.kind === 'number-plus-one' && typeof v === 'number') r[field] = v + 1;
    else if (f.kind === 'number-times-ten' && typeof v === 'number') r[field] = v * 10;
    else if (f.kind === 'flip-boolean' && typeof v === 'boolean') r[field] = !v;
  });
  return copy;
}

let fired = 0;
/** How often the active fault changed a response since the last reset (0 = an equivalent mutant for this test). */
export const faultFired = (): number => fired;
export const resetFaultFired = (): void => {
  fired = 0;
};

/** Remembers what stateful faults need, then corrupts the response when it matches the active fault. */
export async function applyFault(method: string, url: string, res: Response, channel: 'api' | 'ui' = 'api'): Promise<Response> {
  const f = activeFault();
  const m = method.toUpperCase();
  const key = m + ' ' + new URL(url, 'http://suite.invalid').pathname;
  if (m === 'GET') {
    eachRecord(res.body, (r) => {
      for (const k of Object.keys(r)) if (OWNER_KEY.test(k) && r[k] !== null && r[k] !== undefined) {
        const s = seenOwners.get(k) ?? new Set<string>();
        s.add(String(r[k]));
        seenOwners.set(k, s);
      }
    });
  } else {
    for (const [k, v] of lastGet) beforeMutation.set(k, v);
  }
  if (!f || !matches(f, m, url) || (f.channel === 'ui' && channel !== 'ui')) {
    if (m === 'GET') lastGet.set(key, res.body);
    if (res.status >= 200 && res.status < 300 && f && f.method === m) lastOk.set(f.path, res.body);
    return res;
  }
  let out: Response = res;
  switch (f.kind) {
    case 'status-500':
      out = { status: 500, body: { error: 'injected by pramaan mutate' } };
      break;
    case 'status-403-to-200':
      out = [401, 403, 404].includes(res.status) && lastOk.has(f.path) ? { status: 200, body: lastOk.get(f.path) } : res;
      break;
    case 'stale-copy':
      out = beforeMutation.has(key) ? { status: res.status, body: beforeMutation.get(key) } : res;
      break;
    case 'delay-2s':
      await new Promise((r) => setTimeout(r, 2000)); // robustness probe: tests should survive it
      break;
    default:
      out = { status: res.status, body: corrupt(f, res.body) };
  }
  if (f.kind === 'delay-2s' || JSON.stringify(out) !== JSON.stringify(res)) fired += 1;
  if (res.status >= 200 && res.status < 300) lastOk.set(f.path, res.body);
  if (m === 'GET') lastGet.set(key, res.body);
  return out;
}
`;

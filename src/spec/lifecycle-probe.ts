// Lifecycle probe (§8 M3): moves records Pramaan creates through the state machine across roles, so
// multi-role transitions (employee submits → manager approves → employee cancels) become observed.
// Deterministic; touches only records it created (checked by the ownership rule before every write).
import type { Ledger } from '../core/ledger.js';
import type { Http } from '../core/net.js';
import { decideOwnership } from '../core/ownership-guard.js';
import { Steward, teardownOpFrom, type TeardownResult } from '../data/steward.js';
import type { Entity, StateMachine, Transition } from './entities.js';
import type { ObservedOperation } from './har-to-openapi.js';
import { parseJsonMaybe, type Observation } from './observations.js';
import { recordsIn } from './state-machines.js';

export interface ProbeDeps {
  http: Http;
  apiOrigin: string;
  headersFor: (role: string) => Record<string, string> | undefined;
  roles: readonly string[]; // primary-tenant roles with sessions, config order
  ledger: Ledger;
  runId: string;
  runTag: string;
  tagPrefix: string; // "PRM"
  learnedTeardown: Map<string, string>;
  maxAttempts?: number;
}
export interface ProbeResult {
  observations: Observation[];
  confirmed: { from: string; op: string; to: string; actor: string }[];
  missingOps: Set<string>;
  tried: number;
  teardown?: TeardownResult;
}

interface Recipe {
  role: string;
  body: unknown;
}

/** Re-tags free text from an earlier run ("PRM-<old>-…") with this run's tag. */
export function retag(body: unknown, tagPrefix: string, runTag: string): unknown {
  const re = new RegExp(`^${tagPrefix}-\\d{8}-\\d{4}-[0-9a-f]{4}`);
  if (typeof body === 'string') return re.test(body) ? body.replace(re, runTag) : body;
  if (Array.isArray(body)) return body.map((x) => retag(x, tagPrefix, runTag));
  if (body !== null && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, retag(v, tagPrefix, runTag)]));
  }
  return body;
}

/** Shortest list of known (observed) transitions from any initial state to `target`. */
export function pathTo(sm: StateMachine, starts: readonly string[], target: string): Transition[] | undefined {
  const known = sm.transitions.filter((t) => t.observed && t.to !== '?' && t.from !== t.to);
  const prev = new Map<string, { from: string; t: Transition } | null>(starts.map((s) => [s, null]));
  const queue = [...starts];
  while (queue.length > 0) {
    const cur = queue.shift() ?? '';
    if (cur === target) {
      const path: Transition[] = [];
      for (let p = prev.get(cur); p; p = prev.get(p.from)) path.unshift(p.t);
      return path;
    }
    for (const t of known.filter((x) => x.from === cur)) {
      if (prev.has(t.to)) continue;
      prev.set(t.to, { from: cur, t });
      queue.push(t.to);
    }
  }
  return undefined;
}

export async function runLifecycleProbe(
  entity: Entity,
  sm: StateMachine,
  createOp: ObservedOperation,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const steward = new Steward(deps.ledger, deps.runId, 'pramaan:lifecycle-probe');
  const observations: Observation[] = [];
  const confirmed: ProbeResult['confirmed'] = [];
  const missingOps = new Set<string>();
  const tested = new Set<string>();
  const maxAttempts = deps.maxAttempts ?? 4;
  let tried = 0;
  const field = sm.field;
  const idField = entity.idField ?? 'id';
  const working: StateMachine = { ...sm, transitions: sm.transitions.map((t) => ({ ...t })) };

  // Creation recipes by the status the record starts in, from the crawl's successful creates.
  const recipes = new Map<string, Recipe>();
  for (const o of createOp.observations) {
    if (o.status < 200 || o.status >= 300 || o.reqBody === undefined) continue;
    const status = recordsIn(o.resBody)[0]?.[field];
    if (typeof status === 'string' && !recipes.has(status) && deps.roles.includes(o.role)) recipes.set(status, { role: o.role, body: o.reqBody });
  }

  const call = async (role: string, method: string, path: string, body?: unknown): Promise<Observation> => {
    const url = new URL(path, deps.apiOrigin).toString();
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (method !== 'GET') {
      const d = decideOwnership({ method, url, body: text ?? null, isLoginCall: false, createAllowed: path === entity.root, ownedIds: steward.ownedIds() });
      if (!d.allow) throw new Error(`ownership guard: ${d.reason}`);
    }
    const headers = { ...(deps.headersFor(role) ?? {}), ...(text ? { 'content-type': 'application/json' } : {}) };
    const res = await deps.http.request(url, { method, headers, ...(text ? { body: text } : {}) });
    const resText = await res.text();
    const o: Observation = {
      role,
      method,
      url,
      path: new URL(url).pathname,
      query: [],
      status: res.status,
      reqBody: body,
      resBody: parseJsonMaybe(resText, res.headers.get('content-type') ?? undefined),
      location: res.headers.get('location') ?? undefined,
      ts: Date.now(),
      ref: `replay/lifecycle-${deps.runId}.json#${observations.length}`,
    };
    observations.push(o);
    return o;
  };
  const statusOf = (o: Observation): string | undefined => {
    const v = recordsIn(o.resBody)[0]?.[field];
    return typeof v === 'string' ? v : undefined;
  };
  const opPath = (op: string, id: string): { method: string; path: string } => {
    const [method = 'POST', tpl = ''] = op.split(' ');
    return { method, path: tpl.replace('{id}', encodeURIComponent(id)) };
  };

  const create = async (initial: string): Promise<{ id: string; role: string } | undefined> => {
    const recipe = recipes.get(initial);
    if (!recipe) return undefined;
    const o = await call(recipe.role, 'POST', entity.root, retag(recipe.body, deps.tagPrefix, deps.runTag));
    const rec = recordsIn(o.resBody)[0];
    const id = rec?.[idField];
    if (o.status < 200 || o.status >= 300 || (typeof id !== 'string' && typeof id !== 'number')) return undefined;
    steward.recordCreated({ entity: entity.name, id: String(id), operation: createOp.key, role: recipe.role });
    return { id: String(id), role: recipe.role };
  };

  // Every known record operation ("POST /api/leaves/{id}/cancel", including UI hypotheses) is a candidate
  // from every reachable state, so the probe does not depend on which roles' screens the crawl happened to see.
  const recordOps = [
    ...new Set([
      ...entity.operations.filter((k) => !k.startsWith('GET ') && k.includes('{id}')),
      ...working.transitions.map((t) => t.op),
    ]),
  ].sort();
  const addCandidates = (): void => {
    const reachable = new Set([...recipes.keys(), ...working.transitions.filter((t) => t.observed && t.to !== '?').map((t) => t.to)]);
    for (const s of [...reachable].sort()) {
      for (const op of recordOps) {
        if (working.transitions.some((t) => t.from === s && t.op === op)) continue;
        const actors = working.transitions.filter((t) => t.op === op).flatMap((t) => t.actors);
        working.transitions.push({ from: s, op, to: '?', observed: false, actors: [...new Set(actors)], evidenceRefs: [] });
      }
    }
  };

  for (let changed = true; changed; ) {
    changed = false;
    addCandidates();
    for (const t of working.transitions) {
      const k = `${t.from}|${t.op}`;
      if (t.observed || tested.has(k) || missingOps.has(t.op)) continue;
      const starts = [...recipes.keys()];
      const path = pathTo(working, starts, t.from);
      if (!path) continue; // maybe reachable after another transition is confirmed
      tested.add(k);
      tried += 1;
      const start = path[0]?.from ?? t.from;
      const rec = await create(start);
      if (!rec) continue;
      let ok = true;
      for (const step of path) {
        const { method, path: p } = opPath(step.op, rec.id);
        const actor = [...step.actors, rec.role].find((r) => deps.roles.includes(r)) ?? rec.role;
        const o = await call(actor, method, p);
        if (o.status < 200 || o.status >= 300 || statusOf(o) !== step.to) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const actors = [...new Set([...t.actors, rec.role, ...deps.roles])].filter((r) => deps.roles.includes(r)).slice(0, maxAttempts);
      for (const actor of actors) {
        const { method, path: p } = opPath(t.op, rec.id);
        const o = await call(actor, method, p);
        if (o.status === 404 || o.status === 405) {
          // 404 can also mean "not visible to this actor"; only call the op missing if the owner gets it too.
          if (actor === rec.role || o.status === 405) {
            missingOps.add(t.op);
            break;
          }
          continue;
        }
        if (o.status < 200 || o.status >= 300) continue;
        const readBack = await call(rec.role, 'GET', `${entity.root}/${encodeURIComponent(rec.id)}`);
        const to = statusOf(readBack) ?? statusOf(o);
        if (to === undefined) break;
        const [m = 'POST', tpl = ''] = t.op.split(' ');
        const td = teardownOpFrom(m, tpl);
        if (td && !deps.learnedTeardown.has(entity.name)) deps.learnedTeardown.set(entity.name, td);
        confirmed.push({ from: t.from, op: t.op, to, actor });
        const hit = working.transitions.find((x) => x.from === t.from && x.op === t.op);
        if (hit) Object.assign(hit, { to, observed: true, actors: [actor] });
        changed = true;
        break;
      }
    }
  }

  const result: ProbeResult = { observations, confirmed, missingOps, tried };
  if (steward.created.length > 0) {
    result.teardown = await steward.teardown({ http: deps.http, baseUrl: deps.apiOrigin, headersFor: deps.headersFor, learned: deps.learnedTeardown });
  }
  return result;
}


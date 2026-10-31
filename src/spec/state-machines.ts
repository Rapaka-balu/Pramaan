// State machines (§8 M3): a status-like field (string, ≤ 8 values, name ~ status|state|stage) per entity;
// transitions from observed sequences (value before → operation → value after) are observed:true; buttons
// seen in the UI for a status are hypotheses (observed:false) that the lifecycle probe then tries.
import type { ApiModel } from './har-to-openapi.js';
import type { Entity, StateMachine, Transition } from './entities.js';
import type { Observation } from './observations.js';

const STATUS_NAME = /(^|_|[a-z])(status|state|stage)$/i;
const MAX_STATES = 8;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every record object in a body: the body itself, or a list's items. */
export function recordsIn(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isObj);
  if (isObj(body)) return [body, ...(Array.isArray(body['data']) ? body['data'].filter(isObj) : isObj(body['data']) ? [body['data']] : [])];
  return [];
}

export function statusField(entity: Entity, values: (field: string) => Set<string>): string | undefined {
  return entity.fields
    .filter((f) => f.type === 'string' && STATUS_NAME.test(f.name))
    .map((f) => f.name)
    .find((name) => {
      const n = values(name).size;
      return n >= 1 && n <= MAX_STATES;
    });
}

/** UI evidence: in a crawl state that shows exactly one status value, which action names were visible. */
export interface UiHint {
  role: string;
  route: string;
  status: string;
  actions: string[];
  ref: string;
}

/** "Cancel leave" → "cancel"; "Approve" → "approve". */
export const verbOf = (actionName: string): string => (actionName.trim().split(/\s+/)[0] ?? '').toLowerCase();

export function inferStateMachine(
  entity: Entity,
  model: ApiModel,
  hints: readonly UiHint[] = [],
  /** Hypothesized ops the lifecycle probe found do not exist (404/405). */
  missingOps: ReadonlySet<string> = new Set(),
): StateMachine | undefined {
  const ops = model.operations.filter((o) => entity.operations.includes(o.key));
  const obs: (Observation & { key: string })[] = ops
    .flatMap((o) => o.observations.map((x) => ({ ...x, key: o.key })))
    .sort((a, b) => a.ts - b.ts || a.ref.localeCompare(b.ref));
  const idField = entity.idField ?? 'id';
  const valuesOf = (field: string): Set<string> => {
    const s = new Set<string>();
    for (const o of obs) for (const r of recordsIn(o.resBody)) if (typeof r[field] === 'string') s.add(r[field]);
    return s;
  };
  const field = statusField(entity, valuesOf);
  if (field === undefined) return undefined;

  const last = new Map<string, string>(); // record id → last seen status
  const transitions = new Map<string, Transition>();
  const initial = new Set<string>();
  const add = (t: Omit<Transition, 'actors' | 'evidenceRefs'>, actor: string, ref: string): void => {
    const k = `${t.from}|${t.op}|${t.to}`;
    const cur = transitions.get(k) ?? { ...t, actors: [], evidenceRefs: [] };
    cur.observed ||= t.observed;
    if (!cur.actors.includes(actor)) cur.actors.push(actor);
    if (cur.evidenceRefs.length < 5 && !cur.evidenceRefs.includes(ref)) cur.evidenceRefs.push(ref);
    transitions.set(k, cur);
  };

  for (const o of obs) {
    const ok = o.status >= 200 && o.status < 300;
    for (const r of recordsIn(o.resBody)) {
      const id = r[idField];
      const value = r[field];
      if ((typeof id !== 'string' && typeof id !== 'number') || typeof value !== 'string') continue;
      const rid = String(id);
      if (ok && o.method !== 'GET') {
        if (o.key === entity.createOp) initial.add(value);
        else {
          const before = last.get(rid);
          if (before !== undefined) add({ from: before, op: o.key, to: value, observed: true }, o.role, o.ref);
        }
      }
      last.set(rid, value);
    }
  }

  // UI hypotheses: an action visible in status S whose verb matches an observed op's last segment, or a
  // conventional "POST <root>/{id}/<verb>" when the op was never called (it may be denied for the crawler).
  const states = valuesOf(field);
  const knownTo = new Map<string, string>();
  for (const t of transitions.values()) knownTo.set(t.op, t.to);
  for (const h of hints) {
    if (!states.has(h.status)) continue;
    for (const action of h.actions) {
      const verb = verbOf(action);
      if (!/^[a-z]+$/.test(verb)) continue;
      const op =
        ops.find((o) => o.method !== 'GET' && o.path.endsWith(`/{id}/${verb}`))?.key ??
        (entity.createOp ? `POST ${entity.root}/{id}/${verb}` : undefined);
      if (op === undefined || missingOps.has(op)) continue;
      const already = [...transitions.values()].some((t) => t.from === h.status && t.op === op);
      if (already) continue;
      add({ from: h.status, op, to: knownTo.get(op) ?? '?', observed: false }, h.role, h.ref);
    }
  }

  const list = [...transitions.values()].sort((a, b) => `${a.from}|${a.op}`.localeCompare(`${b.from}|${b.op}`));
  for (const t of list) if (t.to !== '?') states.add(t.to);
  return { field, states: [...states].sort(), initial: [...initial].sort(), transitions: list };
}

/** UI hints from crawl state captures: the status value shown (exactly one) and the actions visible. */
export function uiHintsFrom(
  states: readonly { role: string; route: string; aria: string; actions: string[]; ref: string }[],
  statusValues: ReadonlySet<string>,
): UiHint[] {
  const out: UiHint[] = [];
  for (const s of states) {
    // A status appears as a whole cell / definition / text value in the aria snapshot.
    const shown = [...statusValues].filter((v) => new RegExp(`(?:"|: )${v}"?\\s*$`, 'm').test(s.aria));
    if (shown.length !== 1 || !shown[0]) continue;
    out.push({ role: s.role, route: s.route, status: shown[0], actions: s.actions, ref: s.ref });
  }
  return out;
}

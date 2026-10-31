// Fault catalog and mutant planning (§8 M8). A mutant = (test, fault spec). Faults are only planned on operations
// a test touches and fields it reads, so equivalent mutants (dropping a field nobody reads) are never generated.
import type { IndexEntry } from '../bench/run.js';

export const FAULT_KINDS = [
  'drop-field', 'null-field', 'number-plus-one', 'number-times-ten', 'flip-boolean', 'empty-list', 'truncate-list',
  'swap-tenant-id', 'status-500', 'status-403-to-200', 'stale-copy', 'delay-2s',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export interface FaultSpec {
  kind: FaultKind;
  op: string; // "GET /api/leave-balance"
  field?: string;
  /** 'ui' = only browser traffic sees the fault (the screen disagrees with the API). Default: every channel. */
  channel?: 'ui';
}
export const specString = (f: FaultSpec): string => `${f.kind}:${f.op}${f.field ? `#${f.field}` : ''}${f.channel ? `@${f.channel}` : ''}`;

/** Response shape facts the planner needs, from openapi.observed. */
export interface OpShape {
  isList: boolean;
  fieldTypes: Record<string, string>; // top-level (or item) field → json type
}

/** "$.items[*].status" → "status"; "~$.available" → "available"; "$" / "#status" → undefined. */
export function fieldOf(path: string): string | undefined {
  const p = path.replace(/^~/, '');
  if (p === '$' || p.startsWith('#')) return undefined;
  const m = /\.([A-Za-z_][\w-]*)$|\['([^']+)'\]$/.exec(p.replace(/\.length\(\)$/, '').replace(/\[(\*|-?\d+)\]$/g, ''));
  return m?.[1] ?? m?.[2];
}

const OWNER_FIELD = /^(tenant|tenantId|tenant_id|employeeId|employee_id|ownerId|owner_id|userId|user_id)$/;

function kindsForField(type: string | undefined, deltaOnly: boolean): FaultKind[] {
  const numeric: FaultKind[] = deltaOnly ? ['number-times-ten', 'drop-field', 'null-field'] : ['number-plus-one', 'number-times-ten', 'drop-field', 'null-field'];
  if (type === 'integer' || type === 'number') return numeric; // a constant +1 cancels in a delta: equivalent there
  if (type === 'boolean') return ['flip-boolean', 'drop-field'];
  return ['drop-field', 'null-field'];
}

export interface MutantPlan {
  specs: Map<string, { spec: FaultSpec; tests: string[] }>; // spec string → tests it applies to
  robustness: Map<string, { spec: FaultSpec; tests: string[] }>; // delay-2s probes
}

/**
 * Faults are planned per oracle so that a mutant is one the test could detect in principle:
 * - authz-matrix tests compare two callers on the same operation; a body fault every caller sees is equivalent,
 *   so they get status faults only (500, and a denied call turned into a 200 leak);
 * - consistency tests compare the screen with the API; their field faults hit the UI channel only;
 * - rule tests get field faults on what they read (no +1 on delta-only fields), list faults where they read
 *   list items, tenant swaps where they read owner fields, stale-copy where they read after a write.
 */
export function planMutants(tests: readonly IndexEntry[], shapeOf: (op: string) => OpShape | undefined, onlyOps?: readonly string[]): MutantPlan {
  const plan: MutantPlan = { specs: new Map(), robustness: new Map() };
  const add = (into: MutantPlan['specs'], spec: FaultSpec, title: string): void => {
    const k = specString(spec);
    const cur = into.get(k) ?? { spec, tests: [] };
    if (!cur.tests.includes(title)) cur.tests.push(title);
    into.set(k, cur);
  };
  for (const t of tests.filter((x) => x.tags.includes('@regression'))) {
    const writes = t.operations.some((o) => !o.startsWith('GET '));
    for (const [rawOp, paths] of Object.entries(t.reads)) {
      const op = rawOp.split('?')[0] ?? rawOp;
      if (onlyOps && !onlyOps.includes(op)) continue;
      const get = op.startsWith('GET ');
      const shape = shapeOf(op);
      add(plan.specs, { kind: 'status-500', op }, t.title);
      if (get) add(plan.robustness, { kind: 'delay-2s', op }, t.title);
      if (t.oracle === 'authz-matrix') {
        if (get) add(plan.specs, { kind: 'status-403-to-200', op }, t.title);
        continue;
      }
      const ui = t.oracle === 'consistency' ? ({ channel: 'ui' } as const) : {};
      for (const p of paths) {
        const field = fieldOf(p);
        if (field) {
          for (const kind of kindsForField(shape?.fieldTypes[field], p.startsWith('~'))) add(plan.specs, { kind, op, field, ...ui }, t.title);
          if (OWNER_FIELD.test(field)) add(plan.specs, { kind: 'swap-tenant-id', op, ...ui }, t.title);
        }
        if (/\[\*\]|length\(\)$/.test(p)) {
          add(plan.specs, { kind: 'empty-list', op, ...ui }, t.title);
          add(plan.specs, { kind: 'truncate-list', op, ...ui }, t.title);
        }
      }
      if (get && (writes || t.oracle === 'consistency')) add(plan.specs, { kind: 'stale-copy', op, ...ui }, t.title);
    }
  }
  return plan;
}

/** Shapes from the suite's spec/openapi.observed (parsed YAML document). */
export function shapesFromOpenApi(doc: unknown): (op: string) => OpShape | undefined {
  const paths = (doc as { paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { type?: unknown; items?: { properties?: Record<string, { type?: unknown }> }; properties?: Record<string, { type?: unknown }> } }> }> }>> }).paths ?? {};
  return (op: string) => {
    const [method = 'GET', path = ''] = op.split(' ');
    const responses = paths[path]?.[method.toLowerCase()]?.responses ?? {};
    const ok = Object.entries(responses).find(([s]) => s.startsWith('2'))?.[1];
    const schema = ok?.content?.['application/json']?.schema;
    if (!schema) return undefined;
    const isList = schema.type === 'array';
    const props = (isList ? schema.items?.properties : schema.properties) ?? {};
    const typeName = (t: unknown): string => (Array.isArray(t) ? String(t.find((x) => x !== 'null') ?? 'null') : String(t ?? 'unknown'));
    return { isList, fieldTypes: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, typeName(v.type)])) };
  };
}

/** A grep regex selecting exactly these titles (Playwright greps the title path: "<file> <describe> <title> <tags>"). */
export function titlesRegex(titles: readonly string[]): string {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:^|\\s)(?:${[...new Set(titles)].map(esc).join('|')})(?:\\s|$)`;
}

// Entities (§8 M3): operations grouped by shared path root, merged when their record shapes overlap.
// Names are the singular path root (the LLM may rename later; it never invents operations).
import { z } from 'zod';
import { entityFromPath } from '../data/steward.js';
import type { ApiModel, ObservedOperation } from './har-to-openapi.js';
import type { JsonSchema } from './schema-infer.js';

export const Transition = z.object({
  from: z.string(),
  op: z.string(),
  to: z.string(),
  observed: z.boolean(),
  actors: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
});
export const StateMachine = z.object({
  field: z.string(),
  states: z.array(z.string()),
  initial: z.array(z.string()).default([]),
  transitions: z.array(Transition),
});
export const EntityField = z.object({ name: z.string(), type: z.string(), format: z.string().optional(), required: z.boolean() });
export const Entity = z.object({
  name: z.string(),
  root: z.string(), // "/api/leaves"
  operations: z.array(z.string()),
  fields: z.array(EntityField),
  idField: z.string().optional(),
  createOp: z.string().optional(),
  stateMachine: StateMachine.optional(),
});
export const EntitiesFile = z.object({ schemaVersion: z.literal(1), entities: z.array(Entity) });
export type Transition = z.infer<typeof Transition>;
export type StateMachine = z.infer<typeof StateMachine>;
export type Entity = z.infer<typeof Entity>;

/** "/api/leaves/{id}/approve" → "/api/leaves" (path up to the first param, or the whole path). */
export function pathRoot(template: string, apiPrefix = '/api'): string {
  const segs = template.split('/').filter(Boolean);
  const prefix = apiPrefix.split('/').filter(Boolean);
  const start = prefix.every((p, i) => segs[i] === p) ? prefix.length : 0;
  const root = segs[start];
  return `/${[...segs.slice(0, start), ...(root ? [root] : [])].join('/')}`;
}

const isObjSchema = (s: JsonSchema | undefined): s is JsonSchema & { properties: Record<string, JsonSchema> } =>
  !!s?.properties;

/** The record shape an operation returns: the object itself, or a list's items. */
export function recordSchema(op: ObservedOperation): JsonSchema | undefined {
  for (const [status, s] of Object.entries(op.responseSchemas)) {
    if (!status.startsWith('2')) continue;
    if (isObjSchema(s)) return s;
    if (isObjSchema(s.items)) return s.items;
  }
  return undefined;
}

const keysOf = (s: JsonSchema | undefined): Set<string> => new Set(Object.keys(s?.properties ?? {}));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const LOGIN = /(login|logout|signin|signout|auth|token|session)/i;

export function inferEntities(model: ApiModel, apiPrefix = '/api'): Entity[] {
  const groups = new Map<string, ObservedOperation[]>();
  for (const op of model.operations) {
    if (LOGIN.test(op.path)) continue;
    const root = pathRoot(op.path, apiPrefix);
    groups.set(root, [...(groups.get(root) ?? []), op]);
  }
  // Merge a group into another when its records look like the other's (≥ 0.8 Jaccard on field names),
  // e.g. /api/approvals listing leave records. The group with more operations keeps its name.
  const roots = [...groups.keys()].sort();
  const shape = (ops: ObservedOperation[]): Set<string> => {
    const best = ops.map(recordSchema).filter(isObjSchema).sort((a, b) => keysOf(b).size - keysOf(a).size)[0];
    return keysOf(best);
  };
  for (const a of roots) {
    const opsA = groups.get(a);
    if (!opsA) continue;
    for (const b of roots) {
      const opsB = groups.get(b);
      if (a === b || !opsB) continue;
      const sa = shape(opsA);
      if (sa.size < 3 || jaccard(sa, shape(opsB)) < 0.8) continue;
      const [keep, drop] = opsA.length >= opsB.length ? [a, b] : [b, a];
      groups.set(keep, [...(groups.get(keep) ?? []), ...(groups.get(drop) ?? [])]);
      groups.delete(drop);
      if (drop === a) break;
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([root, ops]) => {
      const best = ops.map(recordSchema).filter(isObjSchema).sort((x, y) => keysOf(y).size - keysOf(x).size)[0];
      const required = new Set(best?.required ?? []);
      const fields = Object.entries(best?.properties ?? {}).map(([name, s]) => ({
        name,
        type: Array.isArray(s.type) ? s.type.join('|') : (s.type ?? 'unknown'),
        ...(s.format ? { format: s.format } : {}),
        required: required.has(name),
      }));
      const create = ops.find((o) => o.method === 'POST' && o.path === root && Object.values(o.statusByRole).flat().some((s) => s >= 200 && s < 300));
      return {
        name: entityFromPath(root),
        root,
        operations: ops.map((o) => o.key).sort(),
        fields,
        ...(fields.some((f) => f.name === 'id') ? { idField: 'id' } : {}),
        ...(create ? { createOp: create.key } : {}),
      };
    });
}

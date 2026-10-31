// Observed OpenAPI 3.1 (§8 M3), deterministic. Operations grouped by method + templated path; schemas
// inferred from samples; per-role status codes and evidence in x-pramaan extensions.
import { buildTemplater } from './path-normalize.js';
import type { Observation } from './observations.js';
import { inferSchema, type JsonSchema } from './schema-infer.js';

export interface ObservedOperation {
  key: string; // "POST /api/leaves/{id}/approve"
  method: string;
  path: string; // template
  params: string[]; // path param names in order
  query: string[];
  rolesSeen: string[];
  statusByRole: Record<string, number[]>;
  requestSchema?: JsonSchema | undefined;
  responseSchemas: Record<string, JsonSchema>; // by status code
  sampleCount: number;
  evidenceRefs: string[];
  observations: Observation[]; // kept in memory for entity/state-machine inference; never written to the spec
}

export interface ApiModel {
  operations: ObservedOperation[];
  template(path: string): string;
}

const MAX_REFS = 5;

export function buildApiModel(observations: readonly Observation[]): ApiModel {
  const templater = buildTemplater(observations.map((o) => o.path));
  const byKey = new Map<string, Observation[]>();
  for (const o of [...observations].sort((a, b) => a.ts - b.ts)) {
    const key = `${o.method} ${templater.template(o.path)}`;
    const list = byKey.get(key) ?? [];
    list.push(o);
    byKey.set(key, list);
  }
  const operations: ObservedOperation[] = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, obs]) => {
      const [method = 'GET', path = '/'] = key.split(' ');
      const statusByRole: Record<string, number[]> = {};
      for (const o of obs) statusByRole[o.role] = [...new Set([...(statusByRole[o.role] ?? []), o.status])].sort((a, b) => a - b);
      const byStatus = new Map<number, unknown[]>();
      for (const o of obs) byStatus.set(o.status, [...(byStatus.get(o.status) ?? []), o.resBody]);
      const reqSamples = obs.map((o) => o.reqBody).filter((b) => b !== undefined);
      return {
        key,
        method,
        path,
        params: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? 'id'),
        query: [...new Set(obs.flatMap((o) => o.query))].sort(),
        rolesSeen: Object.keys(statusByRole).sort(),
        statusByRole: Object.fromEntries(Object.entries(statusByRole).sort(([a], [b]) => a.localeCompare(b))),
        requestSchema: reqSamples.length > 0 ? inferSchema(reqSamples) : undefined,
        responseSchemas: Object.fromEntries(
          [...byStatus.entries()].sort(([a], [b]) => a - b).map(([s, bodies]) => [String(s), inferSchema(bodies)]),
        ),
        sampleCount: obs.length,
        evidenceRefs: [...new Set(obs.map((o) => o.ref))].slice(0, MAX_REFS),
        observations: obs,
      };
    });
  return { operations, template: (p) => templater.template(p) };
}

const REASONS: Record<string, string> = {
  '200': 'OK', '201': 'Created', '204': 'No Content', '400': 'Bad Request', '401': 'Unauthorized', '403': 'Forbidden',
  '404': 'Not Found', '405': 'Method Not Allowed', '409': 'Conflict', '422': 'Unprocessable Entity', '500': 'Server Error',
  '503': 'Service Unavailable',
};

const operationId = (op: ObservedOperation): string =>
  `${op.method.toLowerCase()}_${op.path.replace(/^\/+/, '').replace(/\{([^}]+)\}/g, 'by_$1').replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '')}`;

/** The reviewable OpenAPI document. Schemas only — no sample values, so nothing personal leaks into the suite repo. */
export function toOpenApi(model: ApiModel, info: { title: string; serverUrl: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of model.operations) {
    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(op.responseSchemas)) {
      responses[status] = {
        description: REASONS[status] ?? 'Observed',
        ...(Object.keys(schema).length > 0 ? { content: { 'application/json': { schema } } } : {}),
      };
    }
    const parameters = [
      ...op.params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...op.query.map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
    ];
    (paths[op.path] ??= {})[op.method.toLowerCase()] = {
      operationId: operationId(op),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.requestSchema ? { requestBody: { content: { 'application/json': { schema: op.requestSchema } } } } : {}),
      responses,
      'x-pramaan': { rolesSeen: op.rolesSeen, statusByRole: op.statusByRole, sampleCount: op.sampleCount, evidenceRefs: op.evidenceRefs },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: `${info.title} (observed by Pramaan)`, version: 'observed' },
    servers: [{ url: info.serverUrl }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}

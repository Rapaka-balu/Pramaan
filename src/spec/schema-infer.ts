// JSON Schema inference from samples (§8 M3). Types merge into unions; a property is required when it is
// present in every object sample; string formats date, date-time, email and uuid are detected.

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

const FORMATS: [string, RegExp][] = [
  ['date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
];

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string | boolean | object
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Infers one schema covering every sample. Unknown/undefined samples are ignored. */
export function inferSchema(samples: readonly unknown[]): JsonSchema {
  const vals = samples.filter((v) => v !== undefined);
  if (vals.length === 0) return {};
  let types = [...new Set(vals.map(typeOf))];
  // integer ∪ number = number
  if (types.includes('integer') && types.includes('number')) types = types.filter((t) => t !== 'integer');
  types.sort();
  const schema: JsonSchema = { type: types.length === 1 ? (types[0] ?? 'null') : types };

  const strings = vals.filter((v): v is string => typeof v === 'string');
  if (strings.length > 0) {
    const fmt = FORMATS.find(([, re]) => strings.every((s) => re.test(s)));
    if (fmt) schema.format = fmt[0];
  }

  const objects = vals.filter(isObj);
  if (objects.length > 0) {
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].sort();
    schema.properties = Object.fromEntries(keys.map((k) => [k, inferSchema(objects.map((o) => o[k]))]));
    const required = keys.filter((k) => objects.every((o) => k in o));
    if (required.length > 0) schema.required = required;
  }

  const arrays = vals.filter((v): v is unknown[] => Array.isArray(v));
  if (arrays.length > 0) {
    const items = arrays.flat();
    schema.items = items.length > 0 ? inferSchema(items) : {};
  }
  return schema;
}

/** Field paths with their inferred leaf schemas, e.g. "status" → {type:'string'}, "items[].id" → … */
export function leafFields(schema: JsonSchema, prefix = ''): { path: string; schema: JsonSchema }[] {
  const out: { path: string; schema: JsonSchema }[] = [];
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const p = prefix === '' ? k : `${prefix}.${k}`;
    if (s.properties || s.items) out.push(...leafFields(s, p));
    else out.push({ path: p, schema: s });
  }
  if (schema.items) out.push(...leafFields(schema.items, `${prefix}[]`));
  return out;
}

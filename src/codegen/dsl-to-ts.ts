// DSL assertion → readable Playwright test body (§8 M6, §10.2). Steps become `call(...)` / `steward.create(...)`,
// checks become `expect(x, message)`, sections get // Arrange // Act // Assert. Constant expressions are folded at
// compile time; anything the suite cannot evaluate deterministically is a CompileError (the assertion is skipped).
import { evaluateExpr } from '../dsl/expr.js';
import { parseJsonPath } from '../dsl/jsonpath.js';
import type { AssertionT } from '../dsl/validate.js';
import { camel } from './names.js';

export class CompileError extends Error {
  override name = 'CompileError';
}

type Step = AssertionT['act'][number];
type ApiStep = Extract<Step, { kind: 'api' }>;

const ONLY_REF = /^\$\{([^}]+)\}$/;
const ANY_REF = /\$\{([^}]+)\}/g;

export interface EmitContext {
  /** data keys → local const names */
  data: Map<string, string>;
  /** captured names in scope */
  caps: Set<string>;
  /** "POST /api/leaves" → entity name, for steward.create */
  createOps: Map<string, string>;
}

const capVar = (name: string): string => `cap${camel(name).charAt(0).toUpperCase()}${camel(name).slice(1)}`;

function refExpr(ref: string, ctx: EmitContext): string {
  const r = ref.trim();
  if (r === 'run.tag') return 'runTag';
  const day = /^today(?:\s*([+-])\s*(\d+))?$/.exec(r);
  if (day) return `dates.todayPlus(${day[1] === '-' ? '-' : ''}${day[2] ?? '0'})`;
  if (r.startsWith('data.')) {
    const v = ctx.data.get(r.slice(5));
    if (!v) throw new CompileError(`\${${r}} is not in data`);
    return v;
  }
  if (r.startsWith('cap.')) {
    if (!ctx.caps.has(r.slice(4))) throw new CompileError(`\${${r}} is used before it is captured`);
    return capVar(r.slice(4));
  }
  throw new CompileError(`unknown reference \${${r}}`);
}

/** A DSL value as a TypeScript expression. */
export function valueExpr(v: unknown, ctx: EmitContext): string {
  if (typeof v === 'string') {
    const only = ONLY_REF.exec(v);
    if (only?.[1] !== undefined) return refExpr(only[1], ctx);
    if (!ANY_REF.test(v)) return JSON.stringify(v);
    ANY_REF.lastIndex = 0;
    const parts = v.split(ANY_REF);
    // split with a capture group alternates literal, ref, literal, …
    return `\`${parts.map((p, i) => (i % 2 === 1 ? `\${${refExpr(p, ctx)}}` : p.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${'))).join('')}\``;
  }
  if (Array.isArray(v)) return `[${v.map((x) => valueExpr(x, ctx)).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${valueExpr(x, ctx)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(v ?? null);
}

function pathExpr(s: ApiStep, ctx: EmitContext): string {
  const missing = [...s.op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '').filter((n) => !(n in s.pathParams));
  if (missing.length > 0) throw new CompileError(`${s.id}: no value for path params ${missing.join(', ')}`);
  const tpl = s.op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => `\${encodeURIComponent(String(${valueExpr(s.pathParams[name], ctx)}))}`);
  return tpl.includes('${') ? `\`${tpl}\`` : JSON.stringify(tpl);
}

function emitStep(s: Step, ctx: EmitContext): string[] {
  if (s.kind === 'ui') throw new CompileError(`${s.id}: UI steps are not compiled in the MVP`);
  const v = camel(s.id);
  const entity = ctx.createOps.get(`${s.op.method} ${s.op.path}`);
  const lines: string[] = [];
  const query = Object.keys(s.query).length > 0 ? `, params: ${valueExpr(s.query, ctx)}` : '';
  if (entity !== undefined) {
    const body = s.body === undefined ? '{}' : valueExpr(s.body, ctx);
    lines.push(`const ${v} = await steward.create('${entity}', { actor: '${s.actor}', body: ${body} });`);
  } else {
    const opts = [s.body !== undefined ? `data: ${valueExpr(s.body, ctx)}` : '', query.replace(/^, /, '')].filter(Boolean).join(', ');
    lines.push(`const ${v} = await call(await api.as('${s.actor}'), '${s.op.method}', ${pathExpr(s, ctx)}${opts ? `, { ${opts} }` : ''});`);
  }
  for (const [name, p] of Object.entries(s.capture)) {
    parseJsonPath(p);
    lines.push(`const ${capVar(name)} = jp(${v}.body, ${JSON.stringify(p)});`);
    ctx.caps.add(name);
  }
  return lines;
}

function constFold(expr: string, ctx: EmitContext, data: Record<string, unknown>): number {
  if (/\$\{\s*cap\./.test(expr)) throw new CompileError(`delta expression "${expr}" uses a capture; only data/constants are compiled`);
  try {
    return evaluateExpr(expr, (r) => (r.startsWith('data.') ? data[r.slice(5)] : undefined));
  } catch (e) {
    throw new CompileError(`cannot fold "${expr}": ${(e as Error).message}`);
  }
}

function emitCheck(c: AssertionT['assert'][number], ctx: EmitContext, data: Record<string, unknown>): string[] {
  const msg = JSON.stringify(c.message);
  const at = (step: string, path: string): string => `jp(${camel(step)}.body, ${JSON.stringify(path)})`;
  switch (c.kind) {
    case 'status':
      return c.oneOf.length === 1
        ? [`expect(${camel(c.step)}.status, ${msg}).toBe(${c.oneOf[0]});`]
        : [`expect([${c.oneOf.join(', ')}], ${msg}).toContain(${camel(c.step)}.status);`];
    case 'field': {
      const actual = c.normalize === 'none' ? at(c.step, c.path) : `normalize(${at(c.step, c.path)}, '${c.normalize}')`;
      const raw = c.value === undefined ? 'undefined' : valueExpr(c.value, ctx);
      const expected = c.normalize === 'none' || c.value === undefined ? raw : `normalize(${raw}, '${c.normalize}')`;
      const m: Record<string, string> = {
        eq: `toEqual(${expected})`, neq: `not.toEqual(${expected})`, gt: `toBeGreaterThan(Number(${expected}))`,
        gte: `toBeGreaterThanOrEqual(Number(${expected}))`, lt: `toBeLessThan(Number(${expected}))`, lte: `toBeLessThanOrEqual(Number(${expected}))`,
        exists: 'not.toBeUndefined()', absent: 'toBeUndefined()', matches: `toMatch(new RegExp(String(${expected})))`, contains: `toContain(${expected})`,
      };
      if (c.cmp === 'in') return [`expect(${expected} as unknown[], ${msg}).toContain(${actual});`];
      return [`expect(${c.cmp === 'gt' || c.cmp === 'gte' || c.cmp === 'lt' || c.cmp === 'lte' ? `Number(${actual})` : actual}, ${msg}).${m[c.cmp] ?? 'toBeDefined()'};`];
    }
    case 'delta': {
      const expected = constFold(c.expected, ctx, data);
      return [`expect(Number(${at(c.after, c.path)}) - Number(${at(c.before, c.path)}), ${msg}).toBeCloseTo(${expected}, 6);`];
    }
    case 'equalAcross': {
      const vals = c.refs.map((r) => (c.normalize === 'none' ? at(r.step, r.path) : `normalize(${at(r.step, r.path)}, '${c.normalize}')`));
      return [`expect(new Set([${vals.join(', ')}].map((v) => JSON.stringify(v))).size, ${msg}).toBe(1);`];
    }
  }
}

export interface EmittedTest {
  body: string[]; // lines inside the test function
  actors: string[];
  operations: string[];
  /** JSONPaths the test reads, by operation (mutation testing skips faults on fields nobody reads). */
  reads: Record<string, string[]>;
}

export function emitAssertion(a: AssertionT, createOps: Map<string, string>): EmittedTest {
  const ctx: EmitContext = { data: new Map(), caps: new Set(), createOps };
  const body: string[] = ['// Arrange'];
  for (const [k, v] of Object.entries(a.data)) {
    const name = camel(k);
    ctx.data.set(k, name);
    body.push(`const ${name} = ${JSON.stringify(v)};`);
  }
  for (const s of a.arrange) body.push(...emitStep(s, ctx));
  body.push('', '// Act');
  for (const s of a.act) body.push(...emitStep(s, ctx));
  body.push('', '// Assert');
  for (const c of a.assert) body.push(...emitCheck(c, ctx, a.data));
  const steps = [...a.arrange, ...a.act].filter((s): s is ApiStep => s.kind === 'api');
  // cleanup: records made by steward.create are torn down by the steward fixture.
  const opOf = new Map(steps.map((s) => [s.id, `${s.op.method} ${s.op.path}`]));
  const reads: Record<string, string[]> = {};
  const read = (step: string, p: string): void => {
    const op = opOf.get(step);
    if (op) reads[op] = [...new Set([...(reads[op] ?? []), p])].sort();
  };
  const finalBody = dropUnusedBindings(body);
  // A capture counts as a read only if the compiled code still uses it.
  for (const s of steps) {
    for (const [name, p] of Object.entries(s.capture)) if (finalBody.some((l) => l.includes(capVar(name)))) read(s.id, p);
  }
  const deltaPaths = new Map<string, Set<string>>(); // op → paths read only through a delta (a constant offset cancels)
  for (const c of a.assert) {
    if (c.kind === 'status') read(c.step, '#status');
    else if (c.kind === 'field') read(c.step, c.path);
    else if (c.kind === 'delta') {
      for (const st of [c.before, c.after]) {
        const op = opOf.get(st);
        if (op) deltaPaths.set(op, new Set([...(deltaPaths.get(op) ?? []), c.path]));
      }
    } else for (const r of c.refs) read(r.step, r.path);
  }
  for (const [op, paths] of deltaPaths) for (const p of paths) if (!(reads[op] ?? []).includes(p)) reads[op] = [...new Set([...(reads[op] ?? []), `~${p}`])].sort();
  return { body: finalBody, actors: [...new Set(steps.map((s) => s.actor))], operations: [...new Set(steps.map((s) => `${s.op.method} ${s.op.path}`))], reads };
}

/** `const x = await …;` whose x is never read becomes `await …;`; an unread capture line is removed. */
function dropUnusedBindings(lines: string[]): string[] {
  let out = [...lines];
  for (let changed = true; changed; ) {
    changed = false;
    out = out.flatMap((line, i) => {
      const m = /^const ([A-Za-z_$][\w$]*) = (.*)$/.exec(line);
      if (!m?.[1]) return [line];
      // Text inside string literals is not a use: drop "…" literals, and keep only the ${…} parts of templates.
      const code = (l: string): string =>
        l
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/`(?:[^`\\]|\\.)*`/g, (t) => [...t.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? '').join(' '));
      const used = out.some((l, j) => j !== i && new RegExp(`\\b${m[1]}\\b`).test(code(l)));
      if (used) return [line];
      changed = true;
      if (/^jp\(/.test(m[2] ?? '')) return []; // a capture nobody reads
      return /^await /.test(m[2] ?? '') ? [m[2] ?? ''] : [line];
    });
  }
  return out;
}

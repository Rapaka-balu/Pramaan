// ${name} references in assertion values (§4.5): data.x, cap.x, run.tag, today, today±N (Asia/Kolkata).
// A string that is exactly one reference takes the referenced value's type; mixed strings are always strings.
import { istDatePlus } from '../core/time.js';

export class ResolveError extends Error {
  override name = 'ResolveError';
}

export interface ResolveContext {
  data: Record<string, unknown>;
  cap: Record<string, unknown>;
  runTag: string;
  now?: Date;
}

const ONLY_REF = /^\$\{([^}]+)\}$/;
const ANY_REF = /\$\{([^}]+)\}/g;

export function lookup(ref: string, ctx: ResolveContext): unknown {
  const r = ref.trim();
  if (r === 'run.tag') return ctx.runTag;
  const day = /^today(?:\s*([+-])\s*(\d+))?$/.exec(r);
  if (day) return istDatePlus(day[1] === '-' ? -Number(day[2]) : Number(day[2] ?? 0), ctx.now);
  const dot = r.indexOf('.');
  const ns = r.slice(0, dot);
  const key = r.slice(dot + 1);
  if (dot > 0 && (ns === 'data' || ns === 'cap')) {
    const src = ns === 'data' ? ctx.data : ctx.cap;
    return key in src ? src[key] : undefined;
  }
  throw new ResolveError(`unknown reference \${${ref}} (use data.x, cap.x, run.tag, today, today+N)`);
}

export function resolveValue(v: unknown, ctx: ResolveContext): unknown {
  if (typeof v === 'string') {
    const only = ONLY_REF.exec(v);
    if (only?.[1] !== undefined) {
      const val = lookup(only[1], ctx);
      if (val === undefined) throw new ResolveError(`\${${only[1]}} is not defined`);
      return val;
    }
    return v.replace(ANY_REF, (_m, ref: string) => {
      const val = lookup(ref, ctx);
      if (val === undefined) throw new ResolveError(`\${${ref}} is not defined`);
      return typeof val === 'string' ? val : JSON.stringify(val);
    });
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, ctx));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveValue(x, ctx)]));
  return v;
}

/** Names referenced as ${cap.x} anywhere in a value (for static validation). */
export function capRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    for (const m of v.matchAll(ANY_REF)) {
      const ref = m[1]?.trim() ?? '';
      if (ref.startsWith('cap.')) out.add(ref.slice(4));
    }
  } else if (Array.isArray(v)) {
    for (const x of v) capRefs(x, out);
  } else if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) capRefs(x, out);
  }
  return out;
}

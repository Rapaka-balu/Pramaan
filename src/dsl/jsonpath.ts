// JSONPath subset (§4.6): $  .key  ['key']  [n]  [-1]  [*]  and a final length(). Hand-written, no eval.

export class JsonPathError extends Error {
  override name = 'JsonPathError';
}

export type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wildcard' } | { kind: 'length' };

export function parseJsonPath(src: string): Segment[] {
  const s = src.trim();
  if (!s.startsWith('$')) throw new JsonPathError(`JSONPath must start with $: "${src}"`);
  const out: Segment[] = [];
  let i = 1;
  while (i < s.length) {
    if (out.some((x) => x.kind === 'length')) throw new JsonPathError(`length() must be the last segment: "${src}"`);
    const c = s[i];
    if (c === '.') {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*(\(\))?/.exec(s.slice(i + 1));
      if (!m) throw new JsonPathError(`expected a key after "." at ${i} in "${src}"`);
      if (m[1]) {
        if (m[0] !== 'length()') throw new JsonPathError(`unsupported function "${m[0]}" in "${src}" (only length())`);
        out.push({ kind: 'length' });
      } else out.push({ kind: 'key', key: m[0] });
      i += 1 + m[0].length;
    } else if (c === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) throw new JsonPathError(`unclosed "[" at ${i} in "${src}"`);
      const inner = s.slice(i + 1, close).trim();
      if (inner === '*') out.push({ kind: 'wildcard' });
      else if (/^-?\d+$/.test(inner)) out.push({ kind: 'index', index: Number(inner) });
      else {
        const q = /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/.exec(inner);
        if (!q) throw new JsonPathError(`unsupported bracket expression [${inner}] in "${src}" (filters and slices are not supported)`);
        out.push({ kind: 'key', key: (q[1] ?? q[2] ?? '').replace(/\\(.)/g, '$1') });
      }
      i = close + 1;
    } else {
      throw new JsonPathError(`unexpected "${c}" at ${i} in "${src}"`);
    }
  }
  return out;
}

const MISSING = Symbol('missing');

function step(v: unknown, seg: Segment): unknown {
  if (v === MISSING) return MISSING;
  switch (seg.kind) {
    case 'key':
      return v !== null && typeof v === 'object' && !Array.isArray(v) && seg.key in v ? (v as Record<string, unknown>)[seg.key] : MISSING;
    case 'index': {
      if (!Array.isArray(v)) return MISSING;
      const idx = seg.index < 0 ? v.length + seg.index : seg.index;
      return idx >= 0 && idx < v.length ? v[idx] : MISSING;
    }
    case 'length':
      return Array.isArray(v) || typeof v === 'string' ? v.length : v !== null && typeof v === 'object' ? Object.keys(v).length : MISSING;
    case 'wildcard':
      return MISSING; // handled in evaluate
  }
}

/** Value at `path`, or undefined when absent. After [*] the rest maps over every item (missing items dropped). */
export function evaluateJsonPath(path: string | Segment[], value: unknown): unknown {
  const segs = typeof path === 'string' ? parseJsonPath(path) : path;
  const run = (v: unknown, from: number): unknown => {
    let cur: unknown = v;
    for (let k = from; k < segs.length; k++) {
      const seg = segs[k];
      if (!seg) break;
      if (seg.kind === 'wildcard') {
        if (cur === MISSING) return MISSING;
        const items = Array.isArray(cur) ? cur : cur !== null && typeof cur === 'object' ? Object.values(cur) : undefined;
        if (!items) return MISSING;
        const mapped = items.map((x) => run(x, k + 1)).filter((x) => x !== MISSING);
        // A length() right after the wildcard tail applies per item already; the result is the array.
        return mapped;
      }
      cur = step(cur, seg);
    }
    return cur;
  };
  const r = run(value, 0);
  return r === MISSING ? undefined : r;
}

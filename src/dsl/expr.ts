// Expression evaluator (§4.6): numbers, ${refs}, + - * /, unary minus, parentheses, round/floor/ceil/abs/min/max
// and days(a, b) (inclusive day count, Asia/Kolkata calendar dates). Recursive descent; no eval.

export class ExprError extends Error {
  override name = 'ExprError';
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'ref'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' | ',' };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new ExprError(`unclosed \${ at ${i} in "${src}"`);
      out.push({ t: 'ref', v: src.slice(i + 2, end).trim() });
      i = end + 1;
      continue;
    }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z][a-z0-9]*/i.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      out.push({ t: 'op', v: c as '+' });
      i += 1;
      continue;
    }
    throw new ExprError(`unexpected "${c}" at ${i} in "${src}"`);
  }
  return out;
}

export type Resolver = (ref: string) => unknown;

const DAY_MS = 86_400_000;
function dateMs(v: unknown, fn: string): number {
  if (typeof v !== 'string') throw new ExprError(`${fn}: expected a date string, got ${JSON.stringify(v)}`);
  // A date-time is reduced to its Asia/Kolkata calendar date first.
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new ExprError(`${fn}: invalid date-time "${v}"`);
    const ist = new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
    return Date.parse(`${ist}T00:00:00Z`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ExprError(`${fn}: expected YYYY-MM-DD, got "${v}"`);
  return Date.parse(`${v}T00:00:00Z`);
}

const toNum = (v: unknown, where: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new ExprError(`${where}: not a number: ${JSON.stringify(v)}`);
  return n;
};

export function evaluateExpr(src: string, resolve: Resolver): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isOp = (v: string): boolean => {
    const t = peek();
    return t?.t === 'op' && t.v === v;
  };
  const expect = (v: string): void => {
    if (!isOp(v)) throw new ExprError(`expected "${v}" in "${src}"`);
    p += 1;
  };

  // Values flow through as unknown so days() can take date refs; arithmetic coerces to numbers.
  const primary = (): unknown => {
    const t = peek();
    if (!t) throw new ExprError(`unexpected end of "${src}"`);
    if (t.t === 'num') {
      p += 1;
      return t.v;
    }
    if (t.t === 'ref') {
      p += 1;
      const v = resolve(t.v);
      if (v === undefined) throw new ExprError(`unknown reference \${${t.v}} in "${src}"`);
      return v;
    }
    if (t.t === 'op' && t.v === '(') {
      p += 1;
      const v = additive();
      expect(')');
      return v;
    }
    if (t.t === 'id') {
      p += 1;
      expect('(');
      const args: unknown[] = [];
      if (!isOp(')')) {
        args.push(additive());
        while (isOp(',')) {
          p += 1;
          args.push(additive());
        }
      }
      expect(')');
      return call(t.v, args);
    }
    throw new ExprError(`unexpected "${t.v}" in "${src}"`);
  };
  const call = (fn: string, args: unknown[]): number => {
    const n = (i: number): number => toNum(args[i], `${fn}()`);
    const arity = (k: number): void => {
      if (args.length !== k) throw new ExprError(`${fn}() takes ${k} argument(s), got ${args.length}`);
    };
    switch (fn) {
      case 'round': {
        if (args.length !== 1 && args.length !== 2) throw new ExprError('round() takes 1 or 2 arguments');
        const f = 10 ** (args.length === 2 ? n(1) : 0);
        return Math.round(n(0) * f) / f;
      }
      case 'floor':
        arity(1);
        return Math.floor(n(0));
      case 'ceil':
        arity(1);
        return Math.ceil(n(0));
      case 'abs':
        arity(1);
        return Math.abs(n(0));
      case 'min':
      case 'max':
        if (args.length === 0) throw new ExprError(`${fn}() needs arguments`);
        return (fn === 'min' ? Math.min : Math.max)(...args.map((_a, i) => n(i)));
      case 'days':
        arity(2);
        return Math.round((dateMs(args[1], 'days') - dateMs(args[0], 'days')) / DAY_MS) + 1;
      default:
        throw new ExprError(`unknown function ${fn}()`);
    }
  };
  const unary = (): unknown => {
    if (isOp('-')) {
      p += 1;
      return -toNum(unary(), 'unary -');
    }
    if (isOp('+')) {
      p += 1;
      return toNum(unary(), 'unary +');
    }
    return primary();
  };
  const multiplicative = (): unknown => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = (peek() as { v: string }).v;
      p += 1;
      const right = toNum(unary(), op);
      const l = toNum(left, op);
      if (op === '/' && right === 0) throw new ExprError(`division by zero in "${src}"`);
      left = op === '*' ? l * right : l / right;
    }
    return left;
  };
  const additive = (): unknown => {
    let left = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = (peek() as { v: string }).v;
      p += 1;
      const right = toNum(multiplicative(), op);
      left = op === '+' ? toNum(left, op) + right : toNum(left, op) - right;
    }
    return left;
  };

  const v = additive();
  if (p !== toks.length) throw new ExprError(`unexpected trailing input in "${src}"`);
  return toNum(v, 'expression');
}

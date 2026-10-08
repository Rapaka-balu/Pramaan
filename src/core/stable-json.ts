import { createHash } from 'node:crypto';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** JSON.stringify with recursively sorted object keys. Undefined at the top level yields "null". */
export function stableStringify(v: unknown, indent?: number): string {
  const out = JSON.stringify(
    v,
    (_k, val: unknown) => {
      if (!isPlainObject(val)) return val;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val).sort()) sorted[key] = val[key];
      return sorted;
    },
    indent,
  ) as string | undefined;
  return out ?? 'null';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

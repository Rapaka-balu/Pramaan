// API path templating (§8 M3): id-like segments become params; a segment that takes ≥ 3 distinct values
// across otherwise-equal paths is a slug param. Same id rules as the crawler's state key.
import { isIdLikeSegment } from '../core/ownership-guard.js';
import { entityFromPath } from '../data/steward.js';

const PARAM = '\u0000'; // placeholder while templating; named at the end

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function idSegments(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (isIdLikeSegment(decode(s)) ? PARAM : s));
}

/** Names params: a single param is {id}; with several, the last is {id} and earlier ones {<entity>Id}. */
function name(segs: string[]): string {
  const idx = segs.flatMap((s, i) => (s === PARAM ? [i] : []));
  const last = idx[idx.length - 1];
  const out = segs.map((s, i) => {
    if (s !== PARAM) return s;
    if (i === last) return '{id}';
    const prev = segs[i - 1] ?? 'parent';
    const ent = entityFromPath(`/${prev}`).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    return `{${ent}Id}`;
  });
  return `/${out.join('/')}`;
}

export interface PathTemplater {
  template(path: string): string;
}

/**
 * Builds a templater from every observed (method, path). Slug detection: for each segment position, paths
 * that are equal everywhere else and show ≥ 3 distinct values there turn that position into a param.
 */
export function buildTemplater(paths: readonly string[], minDistinct = 3): PathTemplater {
  const base = [...new Set(paths)].map(idSegments);
  const slugPositions = new Map<string, Set<number>>(); // "len|key-with-hole" → positions
  const groups = new Map<string, Set<string>>();
  for (const segs of base) {
    segs.forEach((s, i) => {
      if (s === PARAM) return;
      const hole = segs.map((x, j) => (j === i ? '*' : x)).join('/');
      const k = `${segs.length}|${hole}|${i}`;
      const set = groups.get(k) ?? new Set<string>();
      set.add(s);
      groups.set(k, set);
    });
  }
  // A slug also needs: its parent path observed on its own (a collection, e.g. /api/employees), and values that
  // look like identifiers (a digit somewhere, or ≥ 5 values) — never file names. Otherwise /api/leaves,
  // /api/employees and /api/attendance would collapse into /api/{id}.
  const observed = new Set(base.map((s) => s.join('/')));
  for (const [k, values] of groups) {
    if (values.size < minDistinct) continue;
    const [len, hole, pos] = k.split('|');
    const parent = (hole ?? '').split('/').slice(0, Number(pos)).join('/');
    const vals = [...values];
    if (!observed.has(parent) || vals.some((v) => v.includes('.'))) continue;
    if (!vals.some((v) => /\d/.test(v)) && vals.length < 5) continue;
    const key = `${len}|${hole}`;
    const set = slugPositions.get(key) ?? new Set<number>();
    set.add(Number(pos));
    slugPositions.set(key, set);
  }
  return {
    template(path: string): string {
      const segs = idSegments(path);
      const out = segs.map((s, i) => {
        if (s === PARAM) return s;
        const hole = segs.map((x, j) => (j === i ? '*' : x)).join('/');
        return slugPositions.get(`${segs.length}|${hole}`)?.has(i) ? PARAM : s;
      });
      return name(out);
    },
  };
}

// Role matrix file (§4.4): load/save, merge a fresh replay into it (decided expectations survive), judge it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { MatrixRow, RoleMatrixFile } from '../core/schemas.js';
import { nowIso } from '../core/time.js';
import { violates } from './propose.js';

export type MatrixRow = z.infer<typeof MatrixRow>;
export type RoleMatrix = z.infer<typeof RoleMatrixFile>;

export function loadMatrix(path: string): RoleMatrix {
  if (!existsSync(path)) return { schemaVersion: 1, rows: [] };
  return RoleMatrixFile.parse(parseYaml(readFileSync(path, 'utf8')));
}

export function saveMatrix(path: string, m: RoleMatrix): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toYaml(RoleMatrixFile.parse(m), { lineWidth: 0 }));
}

/**
 * The fresh replay always replaces the observed side. Confirmed/rejected rows keep their expected side and
 * decision; proposed rows take the new proposal. Rows no longer observed are kept (they may be out of reach
 * this run), with their old observations.
 */
export function mergeMatrix(previous: RoleMatrix, fresh: RoleMatrix): RoleMatrix {
  const prev = new Map(previous.rows.map((r) => [r.operation, r]));
  const rows = fresh.rows.map((f) => {
    const p = prev.get(f.operation);
    prev.delete(f.operation);
    if (!p || p.status === 'proposed') return f;
    return { ...f, expected: { ...f.expected, ...p.expected }, status: p.status, ...(p.decision ? { decision: p.decision } : {}) };
  });
  return { schemaVersion: 1, rows: [...rows, ...prev.values()].sort((a, b) => a.operation.localeCompare(b.operation)) };
}

/** Scripted review (tests, and `--confirm-all` for a lead who reviewed the YAML): confirm every proposed row. */
export function confirmAll(m: RoleMatrix, by: string, at = nowIso()): RoleMatrix {
  return {
    ...m,
    rows: m.rows.map((r) => (r.status === 'proposed' ? { ...r, status: 'confirmed', decision: { by, at } } : r)),
  };
}

export interface Contradiction {
  operation: string;
  actor: string;
  expected: string;
  outcome: string;
  status: number;
  confirmed: boolean;
  evidenceRef?: string | undefined;
}

/** Cells whose observed outcome contradicts the expectation. Only confirmed rows produce findings. */
export function contradictions(m: RoleMatrix): Contradiction[] {
  const out: Contradiction[] = [];
  for (const r of m.rows) {
    if (r.status === 'rejected' || r.status === 'retired') continue;
    for (const [actor, exp] of Object.entries(r.expected).sort(([a], [b]) => a.localeCompare(b))) {
      const obs = r.observed[actor];
      if (!obs || !violates(exp, obs.outcome)) continue;
      out.push({ operation: r.operation, actor, expected: exp, outcome: obs.outcome, status: obs.status, confirmed: r.status === 'confirmed', evidenceRef: obs.evidenceRef });
    }
  }
  return out;
}

// Teardown resolution and live-orphan detection (§8 M7).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Http } from '../core/net.js';
import type { Entity } from '../spec/entities.js';
import { parseJsonMaybe } from '../spec/observations.js';
import { recordsIn } from '../spec/state-machines.js';

export interface TeardownPlan {
  op: string; // "POST /api/leaves/{id}/cancel"
  /** Role that must call it; undefined = the role that created the record. */
  actor?: string | undefined;
  /** Status the record ends in, when known (a record already in it is retired, not orphaned). */
  endsIn?: string | undefined;
}

/** DELETE on the record, else an observed cancel/withdraw transition, else reject (by whoever may reject). */
export function resolveTeardown(entity: Entity, learned?: string): TeardownPlan | undefined {
  const del = entity.operations.find((o) => /^DELETE /.test(o) && o.endsWith('/{id}'));
  if (del) return { op: del };
  const t = entity.stateMachine?.transitions.filter((x) => x.observed) ?? [];
  const cancel = t.find((x) => /\/\{id\}\/(cancel|withdraw|revoke)$/.test(x.op));
  if (cancel) return { op: cancel.op, endsIn: cancel.to };
  const reject = t.find((x) => /\/\{id\}\/(reject|decline|deny)$/.test(x.op));
  if (reject) return { op: reject.op, actor: reject.actors[0], endsIn: reject.to };
  return learned ? { op: learned } : undefined;
}

/** States with no observed way out (cancelled, rejected…): a tagged record there needs no cleanup. */
export function terminalStates(entity: Entity): Set<string> {
  const sm = entity.stateMachine;
  if (!sm) return new Set();
  const out = new Set(sm.states);
  for (const t of sm.transitions) if (t.observed && t.from !== t.to) out.delete(t.from);
  for (const s of sm.initial) out.delete(s);
  return out;
}

export interface TaggedRecord {
  entity: string;
  id: string;
  status?: string | undefined;
  seenBy: string;
  tag: string;
}
export interface OrphanReport {
  live: TaggedRecord[];
  retired: TaggedRecord[];
  unchecked: string[]; // entities without a list endpoint
}

const TAG = (prefix: string): RegExp => new RegExp(`^${prefix}-\\d{8}-\\d{4}-[0-9a-f]{4}`);

/** Searches every list endpoint, as every role, for records carrying a Pramaan run tag (optionally one run's). */
export async function findTagged(deps: {
  http: Http;
  apiOrigin: string;
  headersFor: (role: string) => Record<string, string> | undefined;
  roles: readonly string[];
  entities: readonly Entity[];
  tagPrefix: string;
  runTag?: string | undefined;
}): Promise<OrphanReport> {
  const report: OrphanReport = { live: [], retired: [], unchecked: [] };
  const seen = new Set<string>();
  const tagRe = TAG(deps.tagPrefix);
  for (const e of deps.entities) {
    const list = e.operations.find((o) => o === `GET ${e.root}`);
    if (!list) {
      if (e.createOp) report.unchecked.push(e.name);
      continue;
    }
    const terminal = terminalStates(e);
    const field = e.stateMachine?.field;
    for (const role of deps.roles) {
      const headers = deps.headersFor(role);
      if (!headers) continue;
      const res = await deps.http.request(new URL(e.root, deps.apiOrigin).toString(), { headers });
      const body = parseJsonMaybe(await res.text(), res.headers.get('content-type') ?? undefined);
      if (res.status < 200 || res.status >= 300) continue;
      for (const r of recordsIn(body)) {
        const tag = Object.values(r).find((v): v is string => typeof v === 'string' && tagRe.test(v))?.match(tagRe)?.[0];
        const id = r[e.idField ?? 'id'];
        if (!tag || (deps.runTag && tag !== deps.runTag) || (typeof id !== 'string' && typeof id !== 'number')) continue;
        const key = `${e.name}:${String(id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const status = field && typeof r[field] === 'string' ? r[field] : undefined;
        const rec: TaggedRecord = { entity: e.name, id: String(id), status, seenBy: role, tag };
        (status !== undefined && terminal.has(status) ? report.retired : report.live).push(rec);
      }
    }
  }
  return report;
}

/** Records the dev ask for an entity Pramaan cannot clean up (§8 M7 orphan policy), once per app + entity. */
export function noteCleanupAsk(needsFile: string, app: string, entity: string): boolean {
  const line = `- [ ] **${app}: no cleanup operation for \`${entity}\`.** Pramaan-created ${entity} records (tagged \`PRM-…\`) cannot be removed. Ask the devs for a DELETE or cancel endpoint usable on test data.`;
  const text = existsSync(needsFile) ? readFileSync(needsFile, 'utf8') : '# Needs Balu\n';
  if (text.includes(`**${app}: no cleanup operation for \`${entity}\`.**`)) return false;
  const heading = '## Cleanup endpoints (M7 orphan policy)';
  writeFileSync(needsFile, text.includes(heading) ? text.replace(heading, `${heading}\n${line}`) : `${text.trimEnd()}\n\n${heading}\n${line}\n`);
  return true;
}

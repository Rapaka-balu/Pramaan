// Data Steward v0 (§8 M2): records what this run created and tears it down in reverse order.
// M7 adds factories, create() helpers, interrupted-run recovery and the orphan policy.
import { DataCreatedData, type Ledger } from '../core/ledger.js';
import type { Http } from '../core/net.js';
import type { LedgerEvent } from '../core/schemas.js';

export interface CreatedRecord {
  entity: string;
  id: string;
  operation: string; // "POST /api/leaves"
  role: string; // whose session created it; teardown uses the same role
  teardownOp?: string | undefined; // "POST /api/leaves/{id}/cancel" | "DELETE /api/leaves/{id}"
}

/** "/api/leaves" → "leave"; "/api/leave-categories" → "leave-category". */
export function entityFromPath(path: string): string {
  const segs = path.split('/').filter((s) => s !== '' && !/^\{.*\}$/.test(s) && !/^\d+$/.test(s));
  const last = (segs[segs.length - 1] ?? 'record').toLowerCase();
  if (/ies$/.test(last)) return last.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(last)) return last;
  if (/(sh|ch|x|ss|us)es$/.test(last)) return last.replace(/es$/, '');
  return last.replace(/s$/, '');
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asId = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && v !== '' ? v : undefined;

/** The created record's id: body.id, body.<entity>_id / <entity>Id, body.data.id, else the Location header's last segment. */
export function parseCreatedId(body: unknown, location: string | undefined, entity: string): string | undefined {
  const snake = `${entity.replace(/-/g, '_')}_id`;
  const camel = `${entity.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}Id`;
  for (const obj of [body, isObj(body) ? body['data'] : undefined]) {
    if (!isObj(obj)) continue;
    const id = asId(obj['id']) ?? asId(obj[snake]) ?? asId(obj[camel]);
    if (id !== undefined) return id;
  }
  if (location) {
    const last = location.split('?')[0]?.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  }
  return undefined;
}

export interface TeardownDeps {
  http: Http;
  baseUrl: string; // origin the API paths are relative to
  headersFor: (role: string) => Record<string, string> | undefined;
  /** Teardown ops learned during the run, by entity (used when a record has none of its own). */
  learned?: ReadonlyMap<string, string>;
}

export interface TeardownResult {
  deleted: CreatedRecord[];
  retired: CreatedRecord[]; // already in a terminal state (e.g. cancelled during the crawl)
  orphaned: { record: CreatedRecord; reason: string }[];
}

function opUrl(op: string, id: string, baseUrl: string): { method: string; url: string } {
  const [method = 'POST', template = ''] = op.trim().split(/\s+/, 2);
  const path = template.replace(/\{[^}]+\}/, encodeURIComponent(id));
  return { method: method.toUpperCase(), url: new URL(path, baseUrl).toString() };
}

export class Steward {
  private readonly records: CreatedRecord[] = [];

  constructor(
    private readonly ledger: Ledger,
    private readonly runId: string,
    private readonly actor = 'pramaan:steward',
  ) {}

  recordCreated(r: CreatedRecord): void {
    this.records.push(r);
    this.ledger.append({
      runId: this.runId,
      type: 'data.created',
      actor: this.actor,
      data: { entity: r.entity, id: r.id, operation: r.operation, role: r.role, ...(r.teardownOp ? { teardownOp: r.teardownOp } : {}) },
    });
  }

  ownedIds(): Set<string> {
    return new Set(this.records.map((r) => r.id));
  }

  get created(): readonly CreatedRecord[] {
    return this.records;
  }

  /** Records created by `runId`, read back from the ledger (works for an earlier, interrupted run). */
  static recordsOf(events: readonly LedgerEvent[], runId: string): CreatedRecord[] {
    const out: CreatedRecord[] = [];
    for (const e of events) {
      if (e.type !== 'data.created' || e.runId !== runId) continue;
      const d = DataCreatedData.safeParse(e.data);
      if (!d.success) continue;
      const role = typeof e.data['role'] === 'string' ? e.data['role'] : '';
      out.push({ entity: d.data.entity, id: String(d.data.id), operation: d.data.operation, role, teardownOp: d.data.teardownOp });
    }
    return out;
  }

  /** Records of `runId` with neither data.deleted nor data.orphaned yet. */
  static orphans(events: readonly LedgerEvent[], runId: string): CreatedRecord[] {
    const done = new Set(
      events
        .filter((e) => (e.type === 'data.deleted' || e.type === 'data.orphaned') && e.runId === runId)
        .map((e) => `${String(e.data['entity'])}:${String(e.data['id'])}`),
    );
    return Steward.recordsOf(events, runId).filter((r) => !done.has(`${r.entity}:${r.id}`));
  }

  /** Walks the run's records newest first and calls each teardown op as the creating role. */
  async teardown(deps: TeardownDeps, records: readonly CreatedRecord[] = this.records): Promise<TeardownResult> {
    const result: TeardownResult = { deleted: [], retired: [], orphaned: [] };
    for (const r of [...records].reverse()) {
      const op = r.teardownOp ?? deps.learned?.get(r.entity);
      const headers = deps.headersFor(r.role);
      const orphan = (reason: string): void => {
        result.orphaned.push({ record: r, reason });
        this.ledger.append({ runId: this.runId, type: 'data.orphaned', actor: this.actor, data: { entity: r.entity, id: r.id, reason } });
      };
      if (op === undefined) {
        orphan(`no teardown operation known for ${r.entity}`);
        continue;
      }
      if (!headers) {
        orphan(`no session for role ${r.role}`);
        continue;
      }
      const { method, url } = opUrl(op, r.id, deps.baseUrl);
      let status: number;
      try {
        const res = await deps.http.request(url, { method, headers });
        status = res.status;
        await res.body?.cancel();
      } catch (err) {
        orphan(`${op} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // 409 Conflict / 410 Gone: the record already reached a terminal state (e.g. cancelled in the crawl).
      const outcome = status >= 200 && status < 300 ? 'deleted' : status === 409 || status === 410 ? 'retired' : undefined;
      if (outcome === undefined) {
        orphan(`${op} returned HTTP ${status}`);
        continue;
      }
      result[outcome].push(r);
      this.ledger.append({
        runId: this.runId,
        type: 'data.deleted',
        actor: this.actor,
        data: { entity: r.entity, id: r.id, operation: op, status, outcome },
      });
    }
    return result;
  }
}

/** A non-GET on an owned record whose path ends in cancel/withdraw/delete/remove, or a DELETE: a teardown op. */
export function teardownOpFrom(method: string, templatePath: string): string | undefined {
  const m = method.toUpperCase();
  if (m === 'DELETE' && /\{id\}/.test(templatePath)) return `DELETE ${templatePath}`;
  if (m === 'POST' && /\{id\}\/(cancel|withdraw|delete|remove|revoke)$/i.test(templatePath)) return `POST ${templatePath}`;
  return undefined;
}

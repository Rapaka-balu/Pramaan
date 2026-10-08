// Single append-only ledger: workspace/<app>/ledger/events.jsonl (§4.7).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { LedgerEvent, LedgerEventType, OracleClass } from './schemas.js';
import { nowIso } from './time.js';

export type LedgerEventTypeName = z.infer<typeof LedgerEventType>;

export class LedgerValidationError extends Error {
  override name = 'LedgerValidationError';
}

// Required data keys per type (§4.7 comment). Extra keys are allowed.
export const FindingVerdictData = z.looseObject({
  findingId: z.string().min(1),
  oracle: OracleClass,
  verdict: z.enum(['true-positive', 'false-positive', 'duplicate']),
});
export const LeadSessionData = z.looseObject({
  minutes: z.number().nonnegative(),
  itemsDecided: z.number().int().nonnegative(),
});
export const LlmCallData = z.looseObject({
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  cached: z.boolean(),
  purpose: z.string().min(1),
});
export const DataCreatedData = z.looseObject({
  entity: z.string().min(1),
  id: z.union([z.string().min(1), z.number()]),
  operation: z.string().min(1),
  teardownOp: z.string().optional(),
});

const DATA_SCHEMAS: Partial<Record<LedgerEventTypeName, z.ZodType>> = {
  'finding.verdict': FindingVerdictData,
  'lead.session': LeadSessionData,
  'llm.call': LlmCallData,
  'data.created': DataCreatedData,
};

export type LedgerInput = Omit<LedgerEvent, 'ts' | 'app'> & { ts?: string };

export function ledgerPath(root: string, app: string): string {
  return join(root, 'workspace', app, 'ledger', 'events.jsonl');
}

function issues(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function validateLedgerEvent(raw: unknown): LedgerEvent {
  const parsed = LedgerEvent.safeParse(raw);
  if (!parsed.success) throw new LedgerValidationError(`invalid ledger event: ${issues(parsed.error)}`);
  const ev = parsed.data;
  const schema = DATA_SCHEMAS[ev.type];
  if (schema) {
    const d = schema.safeParse(ev.data);
    if (!d.success) throw new LedgerValidationError(`invalid ${ev.type} data: ${issues(d.error)}`);
  }
  return ev;
}

export class Ledger {
  readonly path: string;
  readonly app: string;
  private readonly warn: (msg: string) => void;

  constructor(opts: { root: string; app: string; warn?: (msg: string) => void }) {
    this.app = opts.app;
    this.path = ledgerPath(opts.root, opts.app);
    this.warn = opts.warn ?? ((m) => process.stderr.write(`[ledger] ${m}\n`));
  }

  append(e: LedgerInput): LedgerEvent {
    const ev = validateLedgerEvent({ ...e, ts: e.ts ?? nowIso(), app: this.app });
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(ev) + '\n', 'utf8');
    return ev;
  }

  read(): LedgerEvent[] {
    if (!existsSync(this.path)) return [];
    const out: LedgerEvent[] = [];
    const lines = readFileSync(this.path, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      try {
        out.push(validateLedgerEvent(JSON.parse(line) as unknown));
      } catch (err) {
        this.warn(`skipping malformed line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return out;
  }

  query(filter: { type?: LedgerEventTypeName; runId?: string }): LedgerEvent[] {
    return this.read().filter(
      (e) => (filter.type === undefined || e.type === filter.type) && (filter.runId === undefined || e.runId === filter.runId),
    );
  }
}

/** IDs recorded by data.created events for the given run (the "owned" set). */
export function createdIds(events: readonly LedgerEvent[], runId: string): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== 'data.created' || e.runId !== runId) continue;
    const d = DataCreatedData.safeParse(e.data);
    if (d.success) ids.add(String(d.data.id));
  }
  return ids;
}

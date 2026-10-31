import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { saveMatrix } from '../../src/authz/matrix-io.js';
import { Ledger } from '../../src/core/ledger.js';
import { workspaceDir } from '../../src/core/paths.js';
import { RulesFile } from '../../src/core/schemas.js';
import { buildQueue, weekStartIst, type QueueSources } from '../../src/lead/queue.js';
import { exportReview, importReview, runInteractiveReview } from '../../src/lead/review.js';
import type { LlmClient } from '../../src/llm/client.js';
import { ev } from '../../src/spec/domain-pack.js';
import { loadRules, mergeSeedRules, proposeRules, saveRules, titleSimilarity, type RuleT } from '../../src/spec/rule-proposer.js';

const rule = (id: string, extra: Partial<RuleT> = {}): RuleT => ({
  id,
  title: `Rule number ${id} has a sensible title`,
  kind: 'calculation',
  status: 'proposed',
  confidence: 0.6,
  source: 'domain-pack',
  entities: ['leave'],
  operations: [],
  evidence: [ev('domain-pack', `pack#${id}`)],
  criticality: 3,
  assertionIds: [],
  version: 1,
  ...extra,
});
const fakeLlm = (rules: unknown[]): LlmClient => ({ structured: async () => ({ value: { rules }, source: 'live', usd: 0 }) }) as unknown as LlmClient;
const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'pramaan-m5-'));

describe('titleSimilarity', () => {
  it('scores near-duplicates high and different rules low', () => {
    expect(titleSimilarity('Approving a leave deducts the days', 'Approving a leave deducts the days.')).toBeGreaterThan(0.95);
    expect(titleSimilarity('Approving a leave deducts the days', 'An employee cannot read another leave')).toBeLessThan(0.5);
  });
});

describe('proposeRules', () => {
  const digest = [{ evidence: ev('response', 'GET /api/leaves'), text: 'GET /api/leaves' }];
  const known = new Set(['GET /api/leaves']);
  const base = (llm: LlmClient, existing: RuleT[] = []) => ({ existing, packMatches: [], digest, knownOps: known, llm, ledger: new Ledger({ root: tmpRoot(), app: 'demo' }), runId: 'r1' });
  const p = (title: string, evidenceIds: string[], operations: string[] = []) => ({ title, kind: 'workflow', confidence: 0.8, entities: ['leave'], operations, evidenceIds, criticality: 4 });

  it('drops rules citing unknown evidence and logs the rejection', async () => {
    const opts = base(fakeLlm([p('A leave list only shows the caller own leaves', ['E-deadbeef']), p('Leaves are listed newest first in the table', [digest[0]?.evidence.id ?? ''])]));
    const r = await proposeRules(opts);
    expect(r.added.map((x) => x.title)).toEqual(['Leaves are listed newest first in the table']);
    expect(r.rejected[0]?.reason).toBe('cites unknown evidence E-deadbeef');
    expect(opts.ledger.query({ type: 'llm.rejected-output' })).toHaveLength(1);
    expect(r.added[0]?.evidence[0]?.id).toBe(digest[0]?.evidence.id);
  });
  it('rejects unknown operations and duplicates', async () => {
    const id = digest[0]?.evidence.id ?? '';
    const r = await proposeRules(base(fakeLlm([p('Something about payroll locking here', [id], ['POST /api/payroll']), p('Rule number R-001 has a sensible title', [id])]), [rule('R-001')]));
    expect(r.added).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['uses operations not in openapi.observed: POST /api/payroll', 'duplicate of an existing rule']);
  });
  it('caps new rules at 40 per run and numbers them after existing ones', async () => {
    const id = digest[0]?.evidence.id ?? '';
    // Titles that share no structure, so the duplicate check never fires and only the cap rejects.
    const many = Array.from({ length: 45 }, (_, i) => p(createHash('sha1').update(String(i)).digest('hex').replace(/(.{5})/g, '$1 ').trim(), [id]));
    const r = await proposeRules(base(fakeLlm(many), [rule('R-007')]));
    expect(r.added).toHaveLength(40);
    expect(r.added[0]?.id).toBe('R-008');
    expect(r.rejected.filter((x) => x.reason.startsWith('cap of 40'))).toHaveLength(5);
  });
});

describe('seed rules', () => {
  it('HRMS seed file has 7 confirmed rules and 5 open questions', () => {
    const f = RulesFile.parse(parseYaml(readFileSync(join('apps', 'hrms', 'seed-rules.yaml'), 'utf8')));
    expect(f.rules.filter((r) => r.status === 'confirmed' && r.source === 'lead' && r.decision?.by === 'lead:balu')).toHaveLength(7);
    expect(f.rules.filter((r) => r.status === 'proposed' && r.openQuestion)).toHaveLength(5);
  });
  it('renumbers a seed whose id is taken and skips one already present by title', () => {
    const merged = mergeSeedRules([rule('R-001', { title: 'Approving a leave deducts the requested days' })], [rule('R-001', { title: 'Grace deduction fires on the fourth late arrival' }), rule('R-002', { title: 'Approving a leave deducts the requested days' })]);
    expect(merged.map((r) => r.id)).toEqual(['R-001', 'R-002']);
    expect(merged[1]?.title).toBe('Grace deduction fires on the fourth late arrival');
  });
});

describe('queue', () => {
  const src = (): QueueSources => ({
    rules: [rule('R-001', { criticality: 5, confidence: 0.7 }), rule('R-002', { criticality: 2 }), rule('R-003', { openQuestion: 'Inclusive?' }), rule('R-004', { status: 'confirmed', decision: { by: 'x', at: '2026-10-31T10:00:00+05:30' } })],
    rows: [{ operation: 'GET /api/leaves/{id}', ownerRole: 'employee', expected: { employee2: 'own-only', manager: 'unknown' }, observed: {}, status: 'proposed' }],
    assertions: [],
    findings: [],
  });
  it('ranks by risk × uncertainty and turns open questions into question items', () => {
    const q = buildQueue(src(), 90);
    expect(q.items.map((i) => `${i.id}:${i.kind}`)).toEqual(['R-003:question', 'R-001:rule', 'M:GET /api/leaves/{id}:matrix-row', 'R-002:rule']);
  });
  it('caps at the minutes left and defers the overflow', () => {
    const q = buildQueue(src(), 2.5);
    expect(q.items.map((i) => i.id)).toEqual(['R-003', 'R-001']);
    expect(q.overflow.map((i) => i.id)).toEqual(['M:GET /api/leaves/{id}', 'R-002']);
  });
  it('weeks start on Monday 00:00 IST', () => {
    expect(new Date(weekStartIst(new Date('2026-10-31T10:00:00Z'))).toISOString()).toBe('2026-10-25T18:30:00.000Z');
  });
});

describe('review console', () => {
  const setup = (): { root: string; ledger: Ledger } => {
    const root = tmpRoot();
    const spec = workspaceDir(root, 'demo', 'spec');
    mkdirSync(spec, { recursive: true });
    saveRules(join(spec, 'rules.yaml'), [rule('R-001'), rule('R-002'), rule('R-003', { openQuestion: 'Which wins?' })]);
    saveMatrix(join(spec, 'role-matrix.yaml'), { schemaVersion: 1, rows: [{ operation: 'GET /api/employees', ownerRole: 'admin', expected: { employee: 'deny' }, observed: {}, status: 'proposed' }] });
    return { root, ledger: new Ledger({ root, app: 'demo' }) };
  };

  it('applies scripted decisions, re-asks after edit, and records measured minutes', async () => {
    const { root, ledger } = setup();
    let t = Date.parse('2026-10-31T10:00:00Z');
    const answers = ['confirm', 'edit', 'reject', 'confirm', 'skip'] as const;
    let k = 0;
    const edited: string[] = [];
    const r = await runInteractiveReview(
      { appId: 'demo', stateRoot: root, by: 'lead:test', now: () => new Date((t += 60_000)) },
      async () => {
        const a = answers[k++] ?? 'quit';
        return a === 'confirm' ? { action: 'confirm', note: 'yes' } : { action: a };
      },
      (f) => edited.push(f),
    );
    expect(r.decided).toBe(3);
    expect(edited).toHaveLength(1);
    const rules = loadRules(join(workspaceDir(root, 'demo', 'spec'), 'rules.yaml'));
    expect(rules.find((x) => x.id === 'R-003')).toMatchObject({ status: 'confirmed', decision: { by: 'lead:test', note: 'yes' } });
    const session = ledger.query({ type: 'lead.session' })[0];
    expect(session?.data).toMatchObject({ itemsDecided: 3, minutes: r.minutes });
    expect(r.minutes).toBeGreaterThan(0);
    // Queue order: R-003 (question) → R-001 → R-002 → matrix row (skipped).
    expect(ledger.query({ type: 'rule.decided' }).map((e) => e.data['status'])).toEqual(['confirmed', 'rejected', 'confirmed']);
    expect(ledger.query({ type: 'matrix.decided' })).toHaveLength(0);
  });

  it('round-trips the Markdown checklist, skipping items with both boxes ticked', () => {
    const { root, ledger } = setup();
    const opts = { appId: 'demo', stateRoot: root, by: 'lead:test', now: () => new Date('2026-10-31T10:00:00Z') };
    const { path, items } = exportReview(opts);
    expect(items).toBe(4);
    let md = readFileSync(path, 'utf8');
    const tick = (id: string, box: 'confirm' | 'reject'): void => {
      const start = md.indexOf(`### ${id} `);
      const at = md.indexOf(`- [ ] ${box}`, start);
      md = `${md.slice(0, at)}- [x] ${box}${md.slice(at + `- [ ] ${box}`.length)}`;
    };
    tick('R-001', 'confirm');
    tick('R-002', 'reject');
    tick('R-003', 'confirm');
    tick('R-003', 'reject');
    writeFileSync(path, md);
    const r = importReview(opts, path);
    expect(r).toEqual({ decided: 2, skipped: 2, conflicts: ['R-003'] });
    expect(ledger.query({ type: 'lead.session' })[0]?.data).toMatchObject({ itemsDecided: 2, minutes: 1, estimated: true });
  });
});

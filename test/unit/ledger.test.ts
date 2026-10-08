import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerValidationError, createdIds, ledgerPath } from '../../src/core/ledger.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pramaan-ledger-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const RUN = '20261008-1430-ab12';

describe('Ledger', () => {
  it('stores at workspace/<app>/ledger/events.jsonl', () => {
    expect(ledgerPath(root, 'demo')).toBe(join(root, 'workspace', 'demo', 'ledger', 'events.jsonl'));
  });

  it('appends with ts (+05:30) and app filled, and reads back', () => {
    const l = new Ledger({ root, app: 'demo' });
    const ev = l.append({ runId: RUN, type: 'run.started', actor: 'pramaan:cli', data: {} });
    expect(ev.app).toBe('demo');
    expect(ev.ts).toMatch(/\+05:30$/);
    const lines = readFileSync(ledgerPath(root, 'demo'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(l.read()).toEqual([ev]);
  });

  it('keeps a provided ts', () => {
    const l = new Ledger({ root, app: 'demo' });
    const ev = l.append({ ts: '2026-10-08T14:00:00+05:30', runId: RUN, type: 'run.completed', actor: 'pramaan:cli', data: {} });
    expect(ev.ts).toBe('2026-10-08T14:00:00+05:30');
  });

  it('rejects an unknown type and bad ts', () => {
    const l = new Ledger({ root, app: 'demo' });
    expect(() => l.append({ runId: RUN, type: 'nope' as 'run.started', actor: 'x', data: {} })).toThrow(LedgerValidationError);
    expect(() => l.append({ ts: 'yesterday', runId: RUN, type: 'run.started', actor: 'x', data: {} })).toThrow(LedgerValidationError);
  });

  it.each([
    ['llm.call', { model: 'm', inputTokens: 1, outputTokens: 2, usd: 0.01, cached: false, purpose: 'p' }, { model: 'm', usd: 0.01 }],
    ['data.created', { entity: 'leave', id: '42', operation: 'POST /api/leaves' }, { entity: 'leave', operation: 'POST /api/leaves' }],
    ['finding.verdict', { findingId: 'F-0001', oracle: 'implicit', verdict: 'true-positive' }, { findingId: 'F-0001', oracle: 'implicit', verdict: 'maybe' }],
    ['lead.session', { minutes: 12, itemsDecided: 4 }, { minutes: 12 }],
  ] as const)('validates required data for %s', (type, good, bad) => {
    const l = new Ledger({ root, app: 'demo' });
    expect(() => l.append({ runId: RUN, type, actor: 'pramaan:test', data: { ...good } })).not.toThrow();
    expect(() => l.append({ runId: RUN, type, actor: 'pramaan:test', data: { ...bad } })).toThrow(LedgerValidationError);
  });

  it('skips and warns on malformed lines', () => {
    const warnings: string[] = [];
    const l = new Ledger({ root, app: 'demo', warn: (m) => warnings.push(m) });
    l.append({ runId: RUN, type: 'run.started', actor: 'pramaan:cli', data: {} });
    appendFileSync(l.path, '{not json\n{"type":"run.started"}\n');
    l.append({ runId: RUN, type: 'run.completed', actor: 'pramaan:cli', data: {} });
    expect(l.read().map((e) => e.type)).toEqual(['run.started', 'run.completed']);
    expect(warnings).toHaveLength(2);
  });

  it('returns [] when no file exists', () => {
    expect(new Ledger({ root, app: 'none' }).read()).toEqual([]);
  });

  it('queries by type and runId; createdIds collects owned ids for a run', () => {
    const l = new Ledger({ root, app: 'demo' });
    l.append({ runId: RUN, type: 'data.created', actor: 'pramaan:crawl', data: { entity: 'leave', id: '7', operation: 'POST /api/leaves' } });
    l.append({ runId: RUN, type: 'data.created', actor: 'pramaan:crawl', data: { entity: 'leave', id: 8, operation: 'POST /api/leaves' } });
    l.append({ runId: 'other', type: 'data.created', actor: 'pramaan:crawl', data: { entity: 'leave', id: '9', operation: 'POST /api/leaves' } });
    l.append({ runId: RUN, type: 'run.started', actor: 'pramaan:cli', data: {} });
    expect(l.query({ type: 'data.created' })).toHaveLength(3);
    expect(l.query({ type: 'data.created', runId: RUN })).toHaveLength(2);
    expect(l.query({ runId: RUN })).toHaveLength(3);
    expect(createdIds(l.read(), RUN)).toEqual(new Set(['7', '8']));
  });
});

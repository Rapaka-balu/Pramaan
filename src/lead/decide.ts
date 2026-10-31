// Applies a lead decision to the backing file and records it in the ledger (§4.7 *.decided / finding.verdict).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMatrix, saveMatrix } from '../authz/matrix-io.js';
import type { Ledger } from '../core/ledger.js';
import { workspaceDir } from '../core/paths.js';
import { Finding } from '../core/schemas.js';
import { nowIso } from '../core/time.js';
import { loadAssertions, saveAssertion } from '../spec/assertion-proposer.js';
import { decide as decideRule, loadRules, saveRules } from '../spec/rule-proposer.js';
import type { ReviewItem } from './queue.js';

export type Verdict = 'confirm' | 'reject';

export interface DecisionCtx {
  stateRoot: string;
  app: string;
  by: string; // "lead:balu"
  ledger: Ledger;
  runId: string;
}

/** The file a lead edits for this item (for "edit" in the console). */
export function backingFile(item: ReviewItem, ctx: Pick<DecisionCtx, 'stateRoot' | 'app'>): string {
  const spec = workspaceDir(ctx.stateRoot, ctx.app, 'spec');
  switch (item.kind) {
    case 'rule':
    case 'question':
      return join(spec, 'rules.yaml');
    case 'matrix-row':
      return join(spec, 'role-matrix.yaml');
    case 'assertion':
      return join(spec, 'assertions', `${item.id}.json`);
    case 'finding':
      return join(workspaceDir(ctx.stateRoot, ctx.app, 'findings'), `${item.id}.json`);
  }
}

export function applyDecision(item: ReviewItem, verdict: Verdict, ctx: DecisionCtx, note?: string): void {
  const status = verdict === 'confirm' ? 'confirmed' : 'rejected';
  const decision = { by: ctx.by, at: nowIso(), ...(note ? { note } : {}) };
  const spec = workspaceDir(ctx.stateRoot, ctx.app, 'spec');
  switch (item.kind) {
    case 'rule':
    case 'question': {
      const path = join(spec, 'rules.yaml');
      const rules = loadRules(path).map((r) => (r.id === item.id ? decideRule(r, status, ctx.by, note) : r));
      saveRules(path, rules);
      ctx.ledger.append({ runId: ctx.runId, type: 'rule.decided', actor: ctx.by, data: { ruleId: item.id, status, ...(note ? { note } : {}) } });
      return;
    }
    case 'matrix-row': {
      const path = join(spec, 'role-matrix.yaml');
      const op = item.id.slice(2);
      const m = loadMatrix(path);
      saveMatrix(path, { ...m, rows: m.rows.map((r) => (r.operation === op ? { ...r, status, decision } : r)) });
      ctx.ledger.append({ runId: ctx.runId, type: 'matrix.decided', actor: ctx.by, data: { operation: op, status } });
      return;
    }
    case 'assertion': {
      const dir = join(spec, 'assertions');
      const a = loadAssertions(dir).find((x) => x.id === item.id);
      if (a) saveAssertion(dir, { ...a, status, decision });
      ctx.ledger.append({ runId: ctx.runId, type: 'assertion.decided', actor: ctx.by, data: { assertionId: item.id, status } });
      return;
    }
    case 'finding': {
      const path = backingFile(item, ctx);
      const f = Finding.parse(JSON.parse(readFileSync(path, 'utf8')));
      writeFileSync(path, JSON.stringify({ ...f, status }, null, 2));
      ctx.ledger.append({
        runId: ctx.runId,
        type: 'finding.verdict',
        actor: ctx.by,
        data: { findingId: f.id, oracle: f.oracle, verdict: verdict === 'confirm' ? 'true-positive' : 'false-positive', ...(note ? { note } : {}) },
      });
      return;
    }
  }
}

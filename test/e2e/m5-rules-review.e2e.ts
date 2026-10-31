import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { runAuthz } from '../../src/authz/run.js';
import { Ledger } from '../../src/core/ledger.js';
import { runCrawl } from '../../src/crawler/crawl.js';
import { Steward } from '../../src/data/steward.js';
import { runInteractiveReview, type Choice } from '../../src/lead/review.js';
import { runInfer } from '../../src/spec/infer.js';

test('should_propose_rules_decide_twenty_items_and_dry_run_assertions_when_reviewing_the_demo', async () => {
  test.setTimeout(900_000);
  // Arrange
  await fetch(`${process.env['DEMO_URL'] ?? ''}/__reset`, { method: 'POST' });
  const root = mkdtempSync(join(tmpdir(), 'pramaan-m5-'));
  const crawl = await runCrawl({ appId: 'demo', stateRoot: root });
  expect(crawl.exitCode, crawl.summary).toBe(0);

  // Act 1 — infer proposes rules (keyless: domain pack only; LLM output would go through the same validator)
  const first = await runInfer({ appId: 'demo', stateRoot: root });
  console.log(first.summary);
  const authz = await runAuthz({ appId: 'demo', stateRoot: root });
  expect(authz.exitCode, authz.summary).toBe(0);

  // Assert 1
  expect(first.newRules.length, 'at least 10 rules should be proposed on the demo').toBeGreaterThanOrEqual(10);
  for (const r of first.rules) expect(r.evidence.length, `${r.id} should carry evidence`).toBeGreaterThan(0);
  expect(first.rejectedRules.filter((r) => r.reason.startsWith('cites unknown evidence')), 'no proposed rule may cite unknown evidence').toEqual([]);

  // Act 2 — a scripted lead decides 20 items: everything confirmed except the DD/MM/YYYY rule (the demo shows ISO dates)
  let decided = 0;
  const lead = async (item: { summary: string }): Promise<Choice> => {
    if (decided >= 20) return { action: 'quit' };
    decided += 1;
    return item.summary.includes('DD/MM/YYYY') ? { action: 'reject', note: 'demo renders ISO dates' } : { action: 'confirm' };
  };
  const session = await runInteractiveReview({ appId: 'demo', stateRoot: root, by: 'lead:scripted' }, lead);

  // Assert 2
  expect(session.decided, 'the review console should decide 20 items').toBe(20);
  const events = new Ledger({ root, app: 'demo' }).read();
  const ls = events.filter((e) => e.type === 'lead.session');
  expect(ls.at(-1)?.data, 'the session should be recorded with measured minutes').toMatchObject({ itemsDecided: 20, mode: 'interactive' });
  expect(typeof ls.at(-1)?.data['minutes'], 'minutes should be a number').toBe('number');
  expect(events.filter((e) => e.type === 'rule.decided').length + events.filter((e) => e.type === 'matrix.decided').length, 'every decision should be in the ledger').toBe(20);

  // Act 3 — assertions for the confirmed rules, dry-run on DEMO_BUGS=none
  const second = await runInfer({ appId: 'demo', stateRoot: root });
  console.log(second.summary);

  // Assert 3
  const passed = second.assertionOutcomes.filter((a) => a.status === 'kept' && a.dryRun?.passed);
  expect(passed.length, `at least 6 assertions should dry-run successfully\n${JSON.stringify(second.assertionOutcomes, null, 1)}`).toBeGreaterThanOrEqual(6);
  expect(Steward.orphans(new Ledger({ root, app: 'demo' }).read(), second.runId), 'dry-run records should all be torn down').toEqual([]);
});

// Deterministic failure classification (§8 M9), in the spec's order. The LLM may only summarize, never classify.

export type FailureClass = 'flaky-known' | 'flaky' | 'locator-drift' | 'environment' | 'spec-change' | 'product-bug-candidate';

export interface FailureFacts {
  testId: string;
  signature: string;
  errors: string[]; // original failure messages
  rerun?: { runs: number; passes: number; errors: string[] } | undefined;
  operations: string[]; // from the test index
  knownOps: ReadonlySet<string>; // openapi.observed operations
  quarantinedSignatures: ReadonlySet<string>;
  /** The whole run failed broadly (> 50 % of tests) — an environment problem, not individual bugs. */
  massFailure: boolean;
}

const LOCATOR = /strict mode violation|resolved to 0 elements|waiting for (get[A-Z]\w+\(|locator\()|Timeout \d+ms exceeded[\s\S]*waiting for (get[A-Z]\w+\(|locator\()|element\(s\) not found/i;
const ENVIRONMENT = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|net::ERR_NAME_NOT_RESOLVED|net::ERR_CONNECTION|getaddrinfo|socket hang up|\bHTTP 50[234]\b|Received:\s*50[234]\b|status(?:Code)?\s*[:=]?\s*50[234]\b|login should leave the login page|no session for role/i;
const SPEC_CHANGE = /Received:\s*(404|405)\b|HTTP (404|405)\b/;

export function classifyFailure(f: FailureFacts): { cls: FailureClass; reason: string } {
  if (f.quarantinedSignatures.has(f.signature)) return { cls: 'flaky-known', reason: 'signature is in the quarantine list' };
  if (f.massFailure) return { cls: 'environment', reason: 'more than half of the tests failed at once' };
  const all = [...f.errors, ...(f.rerun?.errors ?? [])].join('\n');
  // The original run failed; one passing rerun is enough to call it flaky.
  if (f.rerun && f.rerun.passes >= 1) return { cls: 'flaky', reason: `failed, then passed ${f.rerun.passes}/${f.rerun.runs} isolated reruns` };
  if (f.rerun && f.rerun.passes === 0 && LOCATOR.test(f.errors.join('\n')) && f.rerun.errors.every((e) => LOCATOR.test(e))) {
    return { cls: 'locator-drift', reason: 'the same locator failed on every rerun' };
  }
  if (ENVIRONMENT.test(all)) return { cls: 'environment', reason: 'login, DNS, connection or 502/503/504 failure' };
  if (SPEC_CHANGE.test(all) && f.operations.some((o) => f.knownOps.has(o.split('?')[0] ?? o))) {
    return { cls: 'spec-change', reason: 'an operation the spec knows now answers 404/405' };
  }
  return { cls: 'product-bug-candidate', reason: f.rerun ? `failed consistently (${f.rerun.runs}/${f.rerun.runs} reruns)` : 'failed (no rerun)' };
}

// Playwright JSON results → one row per test (§8 M9 parser; also used by bench and mutate in M8).
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface TestOutcome {
  file: string; // relative to the suite's testDir, forward slashes
  title: string;
  ok: boolean;
  status: string; // last attempt: passed | failed | timedOut | skipped | interrupted
  runs: number; // attempts across --repeat-each / retries
  passes: number;
  errors: string[]; // messages, ANSI colours removed
  steps: string[]; // titles of failing steps, if any
  attachments: string[]; // paths (trace, screenshot)
}

const Err = z.object({ message: z.string().optional(), stack: z.string().optional() }).loose();
const Result = z
  .object({
    status: z.string(),
    errors: z.array(Err).default([]),
    error: Err.optional(),
    attachments: z.array(z.object({ name: z.string(), path: z.string().optional() }).loose()).default([]),
    steps: z.array(z.object({ title: z.string(), error: Err.optional() }).loose()).default([]),
  })
  .loose();
const Spec = z
  .object({ title: z.string(), file: z.string(), ok: z.boolean(), tests: z.array(z.object({ results: z.array(Result).default([]) }).loose()).default([]) })
  .loose();
interface SuiteT {
  specs?: z.infer<typeof Spec>[] | undefined;
  suites?: SuiteT[] | undefined;
}
const Suite: z.ZodType<SuiteT> = z.lazy(() => z.object({ specs: z.array(Spec).optional(), suites: z.array(Suite).optional() }).loose());
const Report = z.object({ suites: z.array(Suite).default([]) }).loose();

const ESC = String.fromCharCode(27);
const clean = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

export function parseResultsJson(json: unknown): TestOutcome[] {
  const out: TestOutcome[] = [];
  const walk = (s: SuiteT): void => {
    for (const spec of s.specs ?? []) {
      const results = spec.tests.flatMap((t) => t.results);
      const last = results[results.length - 1];
      const errors = results.flatMap((r) => [...r.errors.map((e) => e.message ?? ''), ...(r.error?.message ? [r.error.message] : [])]).filter(Boolean).map(clean);
      out.push({
        file: spec.file.replace(/\\/g, '/'),
        title: spec.title,
        ok: spec.ok,
        status: last?.status ?? 'unknown',
        runs: results.length,
        passes: results.filter((r) => r.status === 'passed').length,
        errors: [...new Set(errors)],
        steps: results.flatMap((r) => r.steps.filter((st) => st.error).map((st) => st.title)),
        attachments: results.flatMap((r) => r.attachments.map((a) => a.path ?? '')).filter(Boolean),
      });
    }
    for (const c of s.suites ?? []) walk(c);
  };
  for (const s of Report.parse(json).suites) walk(s);
  // --repeat-each lists every repeat as its own entry: merge them per test.
  const merged = new Map<string, TestOutcome>();
  for (const o of out) {
    const k = `${o.file}|${o.title}`;
    const m = merged.get(k);
    if (!m) merged.set(k, o);
    else merged.set(k, { ...m, ok: m.ok && o.ok, status: o.status, runs: m.runs + o.runs, passes: m.passes + o.passes, errors: [...new Set([...m.errors, ...o.errors])], steps: [...m.steps, ...o.steps], attachments: [...m.attachments, ...o.attachments] });
  }
  return [...merged.values()];
}

export const parseResults = (path: string): TestOutcome[] => parseResultsJson(JSON.parse(readFileSync(path, 'utf8')) as unknown);

/** Index entries use the suite path ("specs/api/leave.spec.ts"); results use testDir-relative ("api/leave.spec.ts"). */
export const sameFile = (indexFile: string, resultFile: string): boolean => indexFile.endsWith(resultFile) || resultFile.endsWith(indexFile);

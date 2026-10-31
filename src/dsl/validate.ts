// Assertion validation (§4.5, §8 M5): zod shape with readable messages, then static checks — every op exists in
// the observed spec, step ids are unique, checks name earlier steps, ${cap.x} names an earlier capture.
import { z } from 'zod';
import { Assertion } from '../core/schemas.js';
import { parseJsonPath } from './jsonpath.js';
import { capRefs } from './resolve.js';

export type AssertionT = z.infer<typeof Assertion>;
export type ValidationResult = { ok: true; assertion: AssertionT } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Shape problems the zod message would make cryptic, explained first (e.g. a step placed in `assert`). */
function shapeHints(raw: unknown): string[] {
  if (!isObj(raw)) return ['assertion must be a JSON object'];
  const errs: string[] = [];
  const assertList = Array.isArray(raw['assert']) ? raw['assert'] : [];
  assertList.forEach((item, i) => {
    if (isObj(item) && (item['kind'] === 'api' || item['kind'] === 'ui')) {
      const id = typeof item['id'] === 'string' ? item['id'] : `#${i}`;
      errs.push(`assert[${i}]: expected a Check, got a Step — move ${id} to act`);
    }
  });
  return errs;
}

export function validateAssertion(raw: unknown, knownOps: ReadonlySet<string>): ValidationResult {
  const hints = shapeHints(raw);
  if (hints.length > 0) return { ok: false, errors: hints };
  const parsed = Assertion.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const a = parsed.data;
  const errors: string[] = [];
  const steps = [...a.arrange, ...a.act];
  const seen = new Set<string>();
  const captures = new Set<string>();
  for (const s of [...steps, ...a.cleanup]) {
    if (seen.has(s.id)) errors.push(`step id "${s.id}" is used twice`);
    seen.add(s.id);
    if (s.kind === 'api') {
      const key = `${s.op.method} ${s.op.path}`;
      if (!knownOps.has(key)) errors.push(`${s.id}: operation ${key} is not in openapi.observed`);
      for (const name of [...s.op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '')) {
        if (!(name in s.pathParams)) errors.push(`${s.id}: path param {${name}} has no value in pathParams`);
      }
      for (const ref of capRefs([s.pathParams, s.query, s.body])) {
        if (!captures.has(ref)) errors.push(`${s.id}: \${cap.${ref}} is not captured by an earlier step`);
      }
      for (const [name, path] of Object.entries(s.capture)) {
        try {
          parseJsonPath(path);
        } catch (e) {
          errors.push(`${s.id}: capture ${name}: ${(e as Error).message}`);
        }
        captures.add(name);
      }
    }
  }
  const runSteps = new Set(steps.map((s) => s.id));
  const needStep = (ref: string, where: string): void => {
    if (!runSteps.has(ref)) errors.push(`${where}: step "${ref}" is not an arrange/act step`);
  };
  const needPath = (p: string, where: string): void => {
    try {
      parseJsonPath(p);
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`);
    }
  };
  a.assert.forEach((c, i) => {
    const where = `assert[${i}]`;
    if (c.kind === 'status') needStep(c.step, where);
    if (c.kind === 'field') {
      needStep(c.step, where);
      needPath(c.path, where);
    }
    if (c.kind === 'delta') {
      needStep(c.before, where);
      needStep(c.after, where);
      needPath(c.path, where);
    }
    if (c.kind === 'equalAcross') {
      for (const r of c.refs) {
        needStep(r.step, where);
        needPath(r.path, where);
      }
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, assertion: a };
}

// Heal lint (§8 M9): a change may never quietly weaken a test. Compares base vs head with the TypeScript AST and fails
// when, per test, the number of expect() calls drops, a strong matcher becomes a weak one, test.skip / fixme / only or
// waitForTimeout is added — and, in a heal PR, when anything outside pages/ changes.
// Self-contained (typescript + node only): `pramaan compile` transpiles this file into the suite as
// scripts/lint-expect-count.mjs, so the suite's CI runs the very same rules.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

export interface TestFacts {
  expects: number;
  strong: number;
  weak: number;
}
export interface FileFacts {
  tests: Map<string, TestFacts>;
  skips: number; // test.skip / test.fixme / *.only calls
  waits: number; // waitForTimeout calls
}

const STRONG = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toBeCloseTo', 'toContain', 'toContainEqual', 'toMatch', 'toMatchObject', 'toHaveText', 'toHaveValue', 'toHaveURL', 'toHaveCount', 'toHaveLength', 'toHaveProperty', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toThrow', 'toBeVisible', 'toBeHidden']);
const WEAK = new Set(['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeNaN', 'toBeAttached']);

const calleeName = (e: ts.Expression): string => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `${calleeName(e.expression)}.${e.name.text}` : ts.isCallExpression(e) ? `${calleeName(e.expression)}()` : '?');

function titleOf(arg: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!arg) return '(untitled)';
  if (ts.isStringLiteralLike(arg)) return arg.text;
  return arg.getText(sf); // template / computed titles: compare by source text
}

/** True if this call is a matcher applied to expect(...) (e.g. expect(x, m).not.toBe(1)). */
function matcherOf(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  let target: ts.Expression = call.expression.expression;
  while (ts.isPropertyAccessExpression(target)) target = target.expression; // .not / .resolves / .rejects
  if (!ts.isCallExpression(target)) return undefined;
  const root = calleeName(target.expression);
  return root === 'expect' || root === 'expect.soft' || root === 'expect.poll' ? call.expression.name.text : undefined;
}

export function fileFacts(source: string, fileName = 'x.ts'): FileFacts {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const facts: FileFacts = { tests: new Map(), skips: 0, waits: 0 };
  const visit = (node: ts.Node, current: TestFacts | undefined): void => {
    let inner = current;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (/^(test|it|describe|test\.describe)\.(skip|fixme|only)$/.test(name) || /\.only$/.test(name)) facts.skips += 1;
      if (name.endsWith('waitForTimeout')) facts.waits += 1;
      if (name === 'test' || name === 'it') {
        inner = { expects: 0, strong: 0, weak: 0 };
        facts.tests.set(titleOf(node.arguments[0], sf), inner);
      }
      if (current && (name === 'expect' || name === 'expect.soft' || name === 'expect.poll')) current.expects += 1;
      const m = matcherOf(node);
      if (current && m) {
        if (STRONG.has(m)) current.strong += 1;
        if (WEAK.has(m)) current.weak += 1;
      }
    }
    ts.forEachChild(node, (c) => visit(c, inner));
  };
  visit(sf, undefined);
  return facts;
}

export interface Change {
  file: string; // repo-relative, forward slashes
  base?: string | undefined; // undefined = added
  head?: string | undefined; // undefined = deleted
}

export function lintChanges(changes: readonly Change[], opts: { healPr: boolean }): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (opts.healPr && !c.file.startsWith('pages/')) out.push(`${c.file}: a heal may only change pages/`);
    if (!/\.(ts|tsx|mts)$/.test(c.file)) continue;
    const base = c.base === undefined ? undefined : fileFacts(c.base, c.file);
    const head = c.head === undefined ? undefined : fileFacts(c.head, c.file);
    if ((head?.skips ?? 0) > (base?.skips ?? 0)) out.push(`${c.file}: test.skip / test.fixme / .only added`);
    if ((head?.waits ?? 0) > (base?.waits ?? 0)) out.push(`${c.file}: waitForTimeout added`);
    for (const [title, b] of base?.tests ?? []) {
      const h = head?.tests.get(title);
      if (!h) {
        out.push(`${c.file}: test "${title}" was removed`);
        continue;
      }
      if (h.expects < b.expects) out.push(`${c.file}: "${title}" has fewer expect() calls (${b.expects} → ${h.expects})`);
      if (h.strong < b.strong || h.weak > b.weak) out.push(`${c.file}: "${title}" weakened its matchers (strong ${b.strong} → ${h.strong}, weak ${b.weak} → ${h.weak})`);
    }
  }
  return out;
}

/** Changes between a base ref and the working tree head of a git repo. */
export function gitChanges(repo: string, baseRef: string): Change[] {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const names = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').map((s) => s.trim()).filter(Boolean);
  return names.map((file) => {
    let base: string | undefined;
    try {
      base = git('show', `${baseRef}:${file}`);
    } catch {
      base = undefined;
    }
    const abs = `${repo}/${file}`;
    return { file, base, head: existsSync(abs) ? readFileSync(abs, 'utf8') : undefined };
  });
}

/** CLI: node scripts/lint-expect-count.mjs [--base <ref>] [--heal] */
export function main(argv: readonly string[]): number {
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? (argv[baseIdx + 1] ?? 'main') : 'main';
  const problems = lintChanges(gitChanges(process.cwd(), base), { healPr: argv.includes('--heal') });
  for (const p of problems) console.error(`lint-expect-count: ${p}`);
  if (problems.length === 0) console.log(`lint-expect-count: ok (vs ${base})`);
  return problems.length > 0 ? 1 : 0;
}

// Locator-only heal (§8 M9). For a locator-drift failure: find the page-object getter that holds the dead locator,
// reopen only that page, look for exactly one element that is the same thing (same role + name, a testid with the
// same stem, or the same label), and rewrite only that locator expression. Anything else is rejected to the lead.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { Project, SyntaxKind } from 'ts-morph';
import { locatorCode } from '../codegen/generate.js';
import type { AppConfig } from '../core/schemas.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { installOwnershipGuard } from '../core/ownership-guard.js';
import { createTargetGuard } from '../core/target-guard.js';
import { enumerate, type Candidate, type FormField } from '../crawler/candidates.js';
import type { LocatorDescriptor } from '../crawler/locator.js';
import { settle, trackInflight } from '../crawler/settle.js';
import { sessionFiles } from '../onboarding/sessions.js';
import type { CrawlState } from '../codegen/generate.js';

/** The locator Playwright was waiting for, from its call log ("waiting for getByTestId('apply-leave-btn')"). */
export function failingLocator(error: string): LocatorDescriptor | undefined {
  const q = `['"]((?:[^'"\\\\]|\\\\.)*)['"]`;
  const tid = new RegExp(`getByTestId\\(${q}\\)`).exec(error);
  if (tid?.[1] !== undefined) return { strategy: 'testid', value: tid[1] };
  const role = new RegExp(`getByRole\\(${q}, \\{ name: ${q}`).exec(error);
  if (role?.[1] !== undefined && role[2] !== undefined) return { strategy: 'role', value: role[1], name: role[2] };
  const label = new RegExp(`getByLabel\\(${q}`).exec(error);
  if (label?.[1] !== undefined) return { strategy: 'label', value: label[1] };
  const ph = new RegExp(`getByPlaceholder\\(${q}`).exec(error);
  if (ph?.[1] !== undefined) return { strategy: 'placeholder', value: ph[1] };
  const id = /locator\(['"]#([\w-]+)['"]\)|locator\('\[id="([^"]+)"\]'\)/.exec(error);
  if (id?.[1] ?? id?.[2]) return { strategy: 'css-id', value: id[1] ?? id[2] ?? '' };
  return undefined;
}

const sameDescriptor = (a: LocatorDescriptor, b: LocatorDescriptor): boolean =>
  !a.scope && !b.scope && a.strategy === b.strategy && a.value === b.value && (a.name ?? '') === (b.name ?? '');

/** "apply-leave-btn" vs "apply-leave-submit": testids that share all but their last word are the same control. */
export function sameStem(a: string, b: string): boolean {
  const pa = a.split(/[-_]/);
  const pb = b.split(/[-_]/);
  return pa.length >= 2 && pb.length >= 2 && pa.slice(0, -1).join('-') === pb.slice(0, -1).join('-');
}

export interface Replacement {
  descriptor: LocatorDescriptor;
  why: string;
}

/** Exactly one equivalent element on the re-opened page, or the reason there is none / more than one. */
export function findReplacement(
  old: { role?: string | undefined; name?: string | undefined; testid?: string | undefined; label?: string | undefined },
  live: { candidates: Candidate[]; fields: FormField[] },
): Replacement | { reason: string } {
  const plain = live.candidates.filter((c) => !c.descriptor.scope);
  const tries: [string, LocatorDescriptor[]][] = [
    ['same role and accessible name', old.role && old.name ? plain.filter((c) => c.role === old.role && c.name === old.name).map((c) => c.descriptor) : []],
    ['same testid stem', old.testid ? plain.filter((c) => c.testid && c.testid !== old.testid && sameStem(old.testid ?? '', c.testid)).map((c) => c.descriptor) : []],
    ['same label', old.label ? live.fields.filter((f) => f.label === old.label && f.descriptor).map((f) => f.descriptor as LocatorDescriptor) : []],
  ];
  for (const [why, found] of tries) {
    if (found.length === 1 && found[0]) return { descriptor: found[0], why };
    if (found.length > 1) return { reason: `${found.length} elements match by ${why}` };
  }
  return { reason: 'no element with the same role and name, testid stem or label' };
}

export interface PageGetter {
  file: string; // repo-relative
  className: string;
  getter: string;
  expression: string; // current return expression
  openPath: string | undefined; // from open(); undefined when it needs an id
}

/** The page-object getter whose locator is the one that failed. */
export function findGetter(repo: string, old: LocatorDescriptor): PageGetter | undefined {
  const want = locatorCode(old).replace(/'/g, '"');
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
  const dir = join(repo, 'pages');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts')).sort()) {
    const sf = project.addSourceFileAtPath(join(dir, f));
    for (const cls of sf.getClasses()) {
      const goto = cls.getMethod('open')?.getDescendantsOfKind(SyntaxKind.StringLiteral)[0]?.getLiteralValue();
      for (const m of cls.getMethods()) {
        const ret = m.getStatements()[0]?.asKind(SyntaxKind.ReturnStatement)?.getExpression();
        if (ret && ret.getText().replace(/'/g, '"') === want) {
          return { file: `pages/${f}`, className: cls.getName() ?? '', getter: m.getName(), expression: ret.getText(), openPath: goto && !goto.includes('{') ? goto : undefined };
        }
      }
    }
  }
  return undefined;
}

/** Rewrites only the return expression of one getter. Returns the new file text. */
export function patchGetter(source: string, className: string, getter: string, expression: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('x.ts', source);
  const ret = sf.getClassOrThrow(className).getMethodOrThrow(getter).getStatements()[0]?.asKindOrThrow(SyntaxKind.ReturnStatement).getExpressionOrThrow();
  ret?.replaceWithText(expression);
  return sf.getFullText();
}

export interface HealPlan {
  getter: PageGetter;
  before: string;
  after: string;
  why: string;
  newSource: string;
}

/** Re-opens only the drifted page as a role that saw it during the crawl (read-only, guarded), and plans the patch. */
export async function planHeal(opts: {
  repo: string;
  error: string;
  config: AppConfig;
  stateRoot: string;
  states: readonly CrawlState[];
  baseUrl: string;
}): Promise<HealPlan | { reason: string }> {
  const old = failingLocator(opts.error);
  if (!old) return { reason: 'no locator found in the failure message' };
  const getter = findGetter(opts.repo, old);
  if (!getter) return { reason: `no page-object getter returns ${locatorCode(old)}` };
  if (!getter.openPath) return { reason: `${getter.className}.open() needs a record id; heal those by hand` };
  const route = getter.openPath;
  const seen = opts.states.flatMap((s) => s.candidates.map((c) => ({ s, c }))).find(({ c }) => sameDescriptor(c.descriptor, old));
  const seenField = opts.states.flatMap((s) => s.forms.flatMap((f) => f.fields)).find((f) => f.descriptor && sameDescriptor(f.descriptor, old));
  const role = seen?.s.role ?? opts.states.find((s) => new URL(s.url).pathname === route.split('?')[0])?.role;
  if (!role) return { reason: `no crawled role has seen ${route}` };

  const browser = await chromium.launch();
  let live: { candidates: Candidate[]; fields: FormField[] };
  try {
    // The suite's own session from the failing run is freshest (same origin as the run); else the crawl's.
    const suiteAuth = join(opts.repo, '.auth', `${role}.json`);
    const storageState = existsSync(suiteAuth) ? suiteAuth : sessionFiles(opts.stateRoot, opts.config.id, role).state;
    const context = await browser.newContext({ storageState });
    await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
    // Read-only visit: no clicks, and the ownership guard aborts any write anyway.
    await installOwnershipGuard(context, {
      guard: createTargetGuard(opts.config.safety),
      limiter: createRateLimiter(opts.config.safety.maxRps),
      getOwnedIds: () => new Set<string>(),
      createAllowed: () => false,
      isLoginUrl: () => false,
      onBlocked: () => undefined,
    });
    const page = await context.newPage();
    const tracker = trackInflight(page);
    await page.goto(new URL(route, opts.baseUrl).toString());
    await settle(page, tracker);
    const e = await enumerate(page, '');
    live = { candidates: e.candidates, fields: e.forms.flatMap((f) => f.fields) };
    await context.close();
  } finally {
    await browser.close();
  }
  const r = findReplacement({ role: seen?.c.role, name: seen?.c.name, testid: seen?.c.testid ?? (old.strategy === 'testid' ? old.value : undefined), label: seenField?.label }, live);
  if ('reason' in r) return r;
  const after = locatorCode(r.descriptor);
  const source = readFileSync(join(opts.repo, getter.file), 'utf8');
  return { getter, before: getter.expression, after, why: r.why, newSource: patchGetter(source, getter.className, getter.getter, after) };
}

// Per-role BFS crawl (§8 M2). One context per role, HAR recorded, every request through the target guard,
// the API rate limiter and the ownership guard. Deterministic: candidates in DOM order, stable priorities.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Response } from '@playwright/test';
import type { Ledger } from '../core/ledger.js';
import { installOwnershipGuard, isIdLikeSegment } from '../core/ownership-guard.js';
import type { RateLimiter } from '../core/rate-limit.js';
import type { AppConfig } from '../core/schemas.js';
import type { TargetGuard } from '../core/target-guard.js';
import { entityFromPath, parseCreatedId, teardownOpFrom, type Steward } from '../data/steward.js';
import { LOGIN_PATH_RE } from '../onboarding/auth-material.js';
import { enumerate, validationMessages, type Candidate, type FormInfo } from './candidates.js';
import { runFaker, valueFor } from './form-fill.js';
import { Frontier, type FrontierItem } from './frontier.js';
import { locatorFor, type LocatorDescriptor } from './locator.js';
import { classifyAction, type SafetyVerdict } from './safety.js';
import { settle, trackInflight, type InflightTracker } from './settle.js';
import { normalizeRoute, stateKey } from './state-key.js';

export interface CrawlState {
  key: string;
  url: string;
  route: string;
  depth: number;
  /** How to get back here: open entryUrl, then click the chain (no form submits in a chain). */
  entryUrl: string;
  chain: LocatorDescriptor[];
  expand: boolean;
}
export interface Transition {
  from: string;
  candidate: string;
  to: string | null; // null: the action failed or left the allowed origins
  error?: string;
}
export interface RoleCrawlSummary {
  role: string;
  runId: string;
  states: number;
  routes: string[];
  transitions: Transition[];
  skippedBySafety: { deny: number; needsApproval: number; owned: number };
  needsApproval: string[]; // action names held until listed in safety.approvedActions
  networkBlocked: number;
  /** Frontier items dropped because the state no longer exists after a mutation (expected). */
  staleStates: number;
  formsSubmitted: number;
  recordsCreated: number;
  errors: string[];
  stoppedBy: 'frontier-empty' | 'max-states' | 'max-minutes';
  durationMs: number;
}

export interface CrawlRoleOptions {
  browser: Browser;
  config: AppConfig;
  role: string;
  primaryTenant: boolean;
  storageStatePath: string;
  outDir: string; // workspace/<app>/crawl/<role>
  runId: string;
  runTag: string;
  ledger: Ledger;
  steward: Steward;
  guard: TargetGuard;
  limiter: RateLimiter;
  /** Teardown ops observed on owned records, by entity (filled in during the crawl). */
  learnedTeardown: Map<string, string>;
  maxStates?: number;
  maxDepth?: number;
  maxMinutes?: number;
}

const ACTOR = 'pramaan:crawler';

function apiMatcher(config: AppConfig): (url: string) => boolean {
  const apiBase = config.apiBaseUrl ? new URL(config.apiBaseUrl) : undefined;
  return (url: string): boolean => {
    try {
      const u = new URL(url);
      if (apiBase) return u.origin === apiBase.origin && u.pathname.startsWith(apiBase.pathname.replace(/\/$/, ''));
      return u.pathname.startsWith('/api/') || u.pathname === '/api';
    } catch {
      return false;
    }
  };
}

/** "/api/leaves/12/cancel" → "/api/leaves/{id}/cancel" */
export function templatePath(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => (s !== '' && isIdLikeSegment(s) ? '{id}' : s))
    .join('/');
}

export async function crawlRole(o: CrawlRoleOptions): Promise<RoleCrawlSummary> {
  const started = Date.now();
  const maxStates = o.maxStates ?? o.config.crawl.maxStatesPerRole;
  const maxDepth = o.maxDepth ?? o.config.crawl.maxDepth;
  const deadline = started + (o.maxMinutes ?? o.config.crawl.maxMinutesPerRole) * 60_000;
  const isApi = apiMatcher(o.config);
  const origin = new URL(o.config.baseUrl).origin;
  const faker = runFaker(`${o.runId}:${o.role}`);
  const statesDir = join(o.outDir, 'states');
  mkdirSync(statesDir, { recursive: true });

  const summary: RoleCrawlSummary = {
    role: o.role,
    runId: o.runId,
    states: 0,
    routes: [],
    transitions: [],
    skippedBySafety: { deny: 0, needsApproval: 0, owned: 0 },
    needsApproval: [],
    networkBlocked: 0,
    staleStates: 0,
    formsSubmitted: 0,
    recordsCreated: 0,
    errors: [],
    stoppedBy: 'frontier-empty',
    durationMs: 0,
  };
  const blockedSeen = new Set<string>();
  const needsApproval = new Set<string>();
  let submitting = false;

  const context = await o.browser.newContext({
    storageState: o.storageStatePath,
    recordHar: { path: join(o.outDir, 'crawl.har'), mode: 'full', content: 'embed' },
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });
  // tsx/esbuild wraps named functions with __name(); evaluated functions need it in the page too.
  await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
  await installOwnershipGuard(context, {
    guard: o.guard,
    limiter: o.limiter,
    limitWhen: isApi,
    getOwnedIds: () => o.steward.ownedIds(),
    createAllowed: () => submitting,
    isLoginUrl: (url) => LOGIN_PATH_RE.test(new URL(url).pathname),
    onBlocked: (info) => {
      summary.networkBlocked += 1;
      o.ledger.append({ runId: o.runId, type: 'safety.blocked', actor: ACTOR, data: { role: o.role, layer: 'network', ...info } });
    },
  });

  const page = await context.newPage();
  page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
  const tracker: InflightTracker = trackInflight(page);
  let consoleBuf: { type: string; text: string }[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleBuf.push({ type: m.type(), text: m.text().slice(0, 500) });
  });
  page.on('pageerror', (e) => consoleBuf.push({ type: 'pageerror', text: e.message.slice(0, 500) }));

  // Records created and teardown ops learned from API responses.
  const onResponse = async (res: Response): Promise<void> => {
    const req = res.request();
    const method = req.method().toUpperCase();
    if (method === 'GET' || !isApi(res.url()) || res.status() < 200 || res.status() >= 300) return;
    const path = new URL(res.url()).pathname;
    const tpl = templatePath(path);
    if (method === 'POST' && submitting && !tpl.includes('{id}') && !LOGIN_PATH_RE.test(path)) {
      const entity = entityFromPath(tpl);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const id = parseCreatedId(body, (await res.allHeaders())['location'], entity);
      if (id !== undefined && !o.steward.ownedIds().has(id)) {
        o.steward.recordCreated({ entity, id, operation: `POST ${tpl}`, role: o.role });
        summary.recordsCreated += 1;
      }
      return;
    }
    const op = teardownOpFrom(method, tpl);
    if (op !== undefined) {
      const root = tpl.slice(0, tpl.indexOf('/{id}'));
      const entity = entityFromPath(root);
      if (!o.learnedTeardown.has(entity)) o.learnedTeardown.set(entity, op);
    }
  };
  const pending: Promise<void>[] = [];
  page.on('response', (res) => {
    pending.push(onResponse(res).catch(() => undefined));
  });
  const flushResponses = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };

  const states = new Map<string, CrawlState>();
  const formsByState = new Map<string, FormInfo[]>();
  const frontier = new Frontier();
  const visitedRoutes = new Set<string>();
  const exploredLinks = new Set<string>();

  const verdictFor = (c: Candidate): SafetyVerdict =>
    classifyAction(
      { name: c.name, testid: c.testid, formAction: c.formAction, dialogTitle: c.dialogTitle, containerText: c.containerText },
      o.config.safety,
      o.runTag,
    );

  const noteBlocked = (c: Candidate, v: SafetyVerdict, route: string): void => {
    if (v.kind === 'allow') return;
    const id = `${v.kind}|${route}|${c.testid ?? c.role}|${c.name}`;
    if (blockedSeen.has(id)) return;
    blockedSeen.add(id);
    if (v.kind === 'owned') {
      summary.skippedBySafety.owned += 1; // allowed through the owned-record rule; counted, not blocked
      return;
    }
    if (v.kind === 'needs-approval') {
      summary.skippedBySafety.needsApproval += 1;
      needsApproval.add(c.name);
    } else summary.skippedBySafety.deny += 1;
    o.ledger.append({
      runId: o.runId,
      type: 'safety.blocked',
      actor: ACTOR,
      data: { role: o.role, layer: 'ui', verdict: v.kind, pattern: v.pattern, action: c.name, ...(c.testid ? { testid: c.testid } : {}), route },
    });
  };

  const sameOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  /** Snapshot the current page; capture it if it is a new state. */
  const observe = async (depth: number, entryUrl: string, chain: LocatorDescriptor[], expand: boolean): Promise<CrawlState> => {
    const url = page.url();
    const aria = await page.locator('body').ariaSnapshot();
    const key = stateKey(url, aria);
    const known = states.get(key);
    if (known) {
      consoleBuf = [];
      return known;
    }
    const route = normalizeRoute(url);
    const st: CrawlState = { key, url, route, depth, entryUrl, chain, expand: expand && depth < maxDepth };
    states.set(key, st);
    visitedRoutes.add(route);
    const { candidates, forms } = await enumerate(page, o.runTag);
    formsByState.set(key, forms);

    const dir = join(statesDir, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'aria.yml'), aria);
    writeFileSync(join(dir, 'url.txt'), url);
    await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => undefined);
    const withVerdict = candidates.map((c) => ({ ...c, verdict: verdictFor(c).kind }));
    writeFileSync(join(dir, 'candidates.json'), JSON.stringify(withVerdict, null, 2));
    writeFileSync(join(dir, 'forms.json'), JSON.stringify(forms, null, 2));
    writeFileSync(join(dir, 'console.json'), JSON.stringify(consoleBuf, null, 2));
    consoleBuf = [];

    for (const c of candidates) {
      const v = verdictFor(c);
      noteBlocked(c, v, route);
      if (v.kind === 'deny' || v.kind === 'needs-approval' || !st.expand) continue;
      const form = forms.find((f) => f.index === c.formIndex);
      if (c.kind === 'submit') {
        if (!form || form.isLogin || !o.config.crawl.submitForms || !o.primaryTenant) continue;
      }
      let targetRoute: string | undefined;
      if (c.kind === 'link' && c.href) {
        if (!sameOrigin(c.href)) continue;
        targetRoute = normalizeRoute(c.href);
        const linkId = `${targetRoute}|${c.ownedRow ? 'owned' : ''}`;
        if (exploredLinks.has(linkId)) continue;
        exploredLinks.add(linkId);
      }
      const item: FrontierItem = { stateKey: key, candidateKey: c.key, kind: c.kind, targetRoute, landmark: c.landmark, depth, mutating: v.kind === 'owned' };
      frontier.push(item);
    }
    return st;
  };

  const reenter = async (st: CrawlState): Promise<boolean> => {
    await page.goto(st.entryUrl);
    await settle(page, tracker);
    for (const d of st.chain) {
      await locatorFor(page, d).click({ timeout: 5_000 });
      await settle(page, tracker);
    }
    const aria = await page.locator('body').ariaSnapshot();
    return stateKey(page.url(), aria) === st.key;
  };

  const fill = async (form: FormInfo): Promise<void> => {
    for (const f of form.fields) {
      if (!f.descriptor) continue;
      const v = valueFor(f, { runTag: o.runTag, faker });
      const loc = locatorFor(page, f.descriptor);
      if (v.kind === 'fill') await loc.fill(v.value, { timeout: 5_000 });
      else if (v.kind === 'select') await loc.selectOption(v.value, { timeout: 5_000 });
    }
  };

  try {
    await page.goto(new URL(o.config.login.successSignal?.startsWith('/') ? o.config.login.successSignal : '/', o.config.baseUrl).toString());
    await settle(page, tracker);
    await observe(0, page.url(), [], true);

    for (let item = frontier.pop(visitedRoutes); item; item = frontier.pop(visitedRoutes)) {
      if (states.size >= maxStates) {
        summary.stoppedBy = 'max-states';
        break;
      }
      if (Date.now() > deadline) {
        summary.stoppedBy = 'max-minutes';
        break;
      }
      const from = states.get(item.stateKey);
      if (!from) continue;
      const t: Transition = { from: from.key, candidate: item.candidateKey, to: null };
      summary.transitions.push(t);
      try {
        if (!(await reenter(from))) {
          // Not a crawler error: a later mutation (submit, cancel…) changed the data this state showed.
          t.error = 'stale: server data changed since this state was captured';
          summary.staleStates += 1;
          continue;
        }
        const { candidates, forms } = await enumerate(page, o.runTag);
        const c = candidates.find((x) => x.key === item.candidateKey);
        if (!c) {
          t.error = 'candidate not found after re-entry';
          continue;
        }
        // Re-check safety on the live page (row text may have changed).
        const v = verdictFor(c);
        if (v.kind === 'deny' || v.kind === 'needs-approval') {
          noteBlocked(c, v, from.route);
          t.error = `blocked: ${v.kind}`;
          continue;
        }
        const loc = locatorFor(page, c.descriptor);
        if (c.kind === 'submit') {
          const form = forms.find((f) => f.index === c.formIndex);
          if (!form) {
            t.error = 'form vanished';
            continue;
          }
          await fill(form);
          submitting = true;
          try {
            await loc.click({ timeout: 5_000 });
            await settle(page, tracker);
            await flushResponses();
          } finally {
            submitting = false;
          }
          summary.formsSubmitted += 1;
          const msgs = await validationMessages(page);
          const src = formsByState.get(from.key)?.find((f) => f.index === form.index);
          if (src && msgs.length > 0) {
            src.validationMessages = [...new Set([...src.validationMessages, ...msgs])];
            writeFileSync(join(statesDir, from.key, 'forms.json'), JSON.stringify(formsByState.get(from.key), null, 2));
          }
        } else {
          await loc.click({ timeout: 5_000 });
          await settle(page, tracker);
          await flushResponses();
        }
        if (!sameOrigin(page.url())) {
          t.error = `left the app: ${new URL(page.url()).origin}`;
          continue;
        }
        // A new URL, or any action that changed server state (submit, owned-record action), is a fresh
        // anchor: reopening the URL shows the new state, and a mutation must never be replayed.
        const mutated = c.kind === 'submit' || v.kind === 'owned';
        const anchor = mutated || normalizeRoute(page.url()) !== from.route;
        const next = anchor
          ? await observe(from.depth + 1, page.url(), [], true)
          : await observe(from.depth + 1, from.entryUrl, [...from.chain, c.descriptor], true);
        t.to = next.key;
      } catch (err) {
        const lines = (err instanceof Error ? err.message : String(err))
          .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '') // ANSI colours from Playwright
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        t.error = lines[0] ?? 'error';
        // Keep the last call-log line too: it says why (not visible, intercepted, navigation...).
        const why = lines.length > 1 ? ` (${lines[lines.length - 1]})` : '';
        summary.errors.push(`${describeShort(item.candidateKey)}: ${t.error}${why}`.slice(0, 400));
      }
    }
  } finally {
    await flushResponses();
    await context.close(); // flushes the HAR
  }

  summary.states = states.size;
  summary.routes = [...visitedRoutes].sort();
  summary.needsApproval = [...needsApproval].sort();
  summary.durationMs = Date.now() - started;
  writeFileSync(join(o.outDir, 'crawl-summary.json'), JSON.stringify({ ...summary, stateIndex: [...states.values()].map(({ key, url, route, depth }) => ({ key, url, route, depth })) }, null, 2));
  return summary;
}

const describeShort = (key: string): string => (key.length > 80 ? `${key.slice(0, 77)}...` : key);

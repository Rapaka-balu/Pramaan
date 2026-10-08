// Form login (§8 M1): fields by label → placeholder → textbox order, unless app.yaml overrides them.
import type { Locator, Page } from '@playwright/test';

export interface LoginFieldOverrides {
  tenant?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  submit?: string | undefined;
}
export interface LoginInput {
  loginUrl: string; // absolute
  fields: LoginFieldOverrides;
  successSignal?: string | undefined;
  tenantCode?: string | undefined;
  username: string;
  password: string;
  timeoutMs?: number;
}
export interface LoginResult {
  ok: boolean;
  error?: string;
  finalUrl: string;
}

const TENANT_RE = /tenant|company|organi[sz]ation|org(\s|-)?code|client\s?code/i;
const USER_RE = /e-?mail|user\s?name|login\s?id|user\s?id/i;
const PASSWORD_RE = /password/i;
const SUBMIT_RE = /^\s*(sign\s?in|log\s?in|login|submit|continue)\s*$/i;
const ERROR_TEXT_RE = /invalid|incorrect|wrong|failed|not found|unauthori[sz]ed|does not exist|try again/i;

async function firstUnique(candidates: Locator[]): Promise<Locator | undefined> {
  for (const c of candidates) {
    if ((await c.count()) === 1 && (await c.isVisible())) return c;
  }
  return undefined;
}

async function textbox(page: Page, index: number): Promise<Locator | undefined> {
  const boxes = page.getByRole('textbox');
  return (await boxes.count()) > index ? boxes.nth(index) : undefined;
}

export async function findLoginFields(
  page: Page,
  overrides: LoginFieldOverrides,
  withTenant: boolean,
): Promise<{ tenant?: Locator; username: Locator; password: Locator; submit: Locator }> {
  const tenant = !withTenant
    ? undefined
    : overrides.tenant
      ? page.locator(overrides.tenant)
      : await firstUnique([page.getByLabel(TENANT_RE), page.getByPlaceholder(TENANT_RE)]) ?? (await textbox(page, 0));
  const username = overrides.username
    ? page.locator(overrides.username)
    : await firstUnique([page.getByLabel(USER_RE), page.getByPlaceholder(USER_RE)]) ??
      (await textbox(page, withTenant ? 1 : 0));
  const password = overrides.password
    ? page.locator(overrides.password)
    : await firstUnique([
        page.getByLabel(PASSWORD_RE),
        page.getByPlaceholder(PASSWORD_RE),
        page.locator('input[type="password"]'),
      ]);
  const submit = overrides.submit
    ? page.locator(overrides.submit)
    : await firstUnique([
        page.getByRole('button', { name: SUBMIT_RE }),
        page.locator('button[type="submit"], input[type="submit"]'),
      ]);
  const missing = [
    ...(withTenant && !tenant ? ['tenant'] : []),
    ...(!username ? ['username'] : []),
    ...(!password ? ['password'] : []),
    ...(!submit ? ['submit'] : []),
  ];
  if (missing.length > 0 || !username || !password || !submit) {
    throw new Error(`login form: could not find ${missing.join(', ')} field(s); set login.fields in app.yaml`);
  }
  return { ...(tenant ? { tenant } : {}), username, password, submit };
}

function signalMatches(url: URL, signal: string | undefined, loginPath: string): boolean {
  if (signal?.startsWith('/')) return url.pathname === signal || url.pathname.startsWith(`${signal}/`);
  return url.pathname !== loginPath;
}

/** Fills and submits the login form, then waits for success (URL/signal) or visible error text. */
export async function loginWithForm(page: Page, input: LoginInput): Promise<LoginResult> {
  const timeout = input.timeoutMs ?? 15_000;
  await page.goto(input.loginUrl);
  const fields = await findLoginFields(page, input.fields, Boolean(input.tenantCode));
  if (fields.tenant && input.tenantCode) await fields.tenant.fill(input.tenantCode);
  await fields.username.fill(input.username);
  await fields.password.fill(input.password);
  const loginPath = new URL(page.url()).pathname;
  await fields.submit.click();

  const alert = page.getByRole('alert').filter({ hasText: /\S/ }).first();
  const errorText = page.getByText(ERROR_TEXT_RE).first();
  const textSignal =
    input.successSignal && !input.successSignal.startsWith('/') && !input.successSignal.includes('*')
      ? page.getByText(input.successSignal).first()
      : undefined;
  const outcome = await Promise.race([
    page
      .waitForURL((u) => signalMatches(u, input.successSignal, loginPath), { timeout })
      .then(() => 'navigated' as const),
    ...(textSignal ? [textSignal.waitFor({ state: 'visible', timeout }).then(() => 'signal' as const)] : []),
    alert.waitFor({ state: 'visible', timeout }).then(() => 'error' as const),
    errorText.waitFor({ state: 'visible', timeout }).then(() => 'error' as const),
  ].map((p) => p.catch(() => 'timeout' as const)));

  const visibleError = async (): Promise<string | undefined> => {
    for (const l of [alert, errorText]) {
      if (await l.isVisible().catch(() => false)) return (await l.innerText()).trim().slice(0, 300);
    }
    return undefined;
  };
  const err = await visibleError();
  if (outcome === 'error' || err) return { ok: false, error: err ?? 'login error shown', finalUrl: page.url() };
  if (outcome === 'timeout') {
    return { ok: false, error: `no success signal within ${timeout / 1000}s (still on ${new URL(page.url()).pathname})`, finalUrl: page.url() };
  }
  // Let the landing page make its authenticated API calls so the HAR shows how auth works.
  await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
  return { ok: true, finalUrl: page.url() };
}

// Candidate enumeration (§8 M2): clickable links/buttons/tabs/menuitems + visible, enabled [data-testid]
// elements, each with a §2.2 locator descriptor that resolves to exactly one element. Also detects forms.
import type { Page } from '@playwright/test';
import { z } from 'zod';
import type { FieldFacts } from './form-fill.js';
import { describeLocator, ladder, LocatorDescriptor, locatorFor, type LocatorScope } from './locator.js';

/** Raw facts gathered in the page for one interactive element. */
interface RawElement {
  tag: string;
  role: string;
  name: string;
  testid: string | null;
  id: string | null;
  href: string | null;
  isSubmit: boolean;
  formIndex: number; // -1 when not in a form
  landmark: boolean;
  dialogTitle: string | null;
  containerText: string;
  row: { testid: string | null; role: string; hasText: string; owned: boolean; index: number; repeated: boolean } | null;
}
interface RawField extends FieldFacts {
  testid: string | null;
  id: string | null;
}
interface RawForm {
  index: number;
  id: string | null;
  action: string | null;
  hasPassword: boolean;
  fields: RawField[];
}

// Runs in the browser. Keep it self-contained (it is serialized).
function collectInPage(runTag: string): { elements: RawElement[]; forms: RawForm[] } {
  const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element): boolean => {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const textOf = (el: Element | null): string => (el instanceof HTMLElement ? norm(el.innerText) : norm(el?.textContent));
  const byIds = (ids: string | null): string =>
    norm((ids ?? '').split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' '));
  const labelOf = (el: Element): string => {
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
    if (el.getAttribute('aria-labelledby')) return byIds(el.getAttribute('aria-labelledby'));
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) return norm(Array.from(labels).map((l) => textOf(l)).join(' '));
    return '';
  };
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    // Only interactive explicit roles; role=status/region/... fall through to the bare-testid check.
    const r = explicit?.split(/\s+/)[0];
    if (r && /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|switch|treeitem)$/.test(r)) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
    }
    return '';
  };
  const nameOf = (el: Element): string => {
    const l = labelOf(el);
    if (l) return l;
    if (el instanceof HTMLInputElement) return norm(el.value);
    return textOf(el) || norm(el.getAttribute('title'));
  };
  const forms = Array.from(document.querySelectorAll('form'));

  const SELECTOR = 'a[href], button, input[type=submit], input[type=button], summary, [role=button], [role=link], [role=tab], [role=menuitem], [data-testid]';
  const elements: RawElement[] = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (!visible(el)) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const tag = el.tagName.toLowerCase();
    // In-page anchors (skip links, #section) never change the state.
    if (tag === 'a' && (el.getAttribute('href') ?? '').startsWith('#')) continue;
    let role = roleOf(el);
    const testid = el.getAttribute('data-testid');
    if (role === '') {
      // A bare [data-testid]: only if it looks clickable and holds no other controls (not a table or a field).
      if (['input', 'textarea', 'select', 'option', 'label'].includes(tag)) continue;
      if (el.querySelector('a[href], button, input, select, textarea')) continue;
      const clickable = el.hasAttribute('onclick') || (el as HTMLElement).tabIndex >= 0 || getComputedStyle(el).cursor === 'pointer';
      if (!clickable) continue;
      role = 'generic';
    }
    const dialog = el.closest('dialog, [role=dialog], [role=alertdialog]');
    const rowEl = el.closest('tr, [role=row], li');
    const container = rowEl ?? dialog ?? el.closest('section, article, form');
    const form = (el as HTMLButtonElement).form ?? el.closest('form');
    const isSubmit =
      form !== null &&
      ((tag === 'button' && ((el as HTMLButtonElement).type || 'submit') === 'submit') || (tag === 'input' && (el as HTMLInputElement).type === 'submit'));
    let row: RawElement['row'] = null;
    if (rowEl && rowEl.parentElement) {
      const siblings = Array.from(rowEl.parentElement.children).filter((c) => c.tagName === rowEl.tagName);
      const rowText = textOf(rowEl);
      const parts = Array.from(rowEl.children).map((c) => textOf(c)).filter((t) => t !== '');
      const tagged = parts.find((p) => runTag !== '' && p.includes(runTag));
      const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
      row = {
        testid: rowEl.getAttribute('data-testid'),
        role: rowEl.tagName.toLowerCase() === 'li' ? 'listitem' : 'row',
        hasText: (tagged ?? longest ?? rowText).slice(0, 80),
        owned: runTag !== '' && rowText.includes(runTag),
        index: siblings.indexOf(rowEl),
        repeated: siblings.length > 1,
      };
    }
    elements.push({
      tag,
      role,
      name: nameOf(el),
      testid,
      id: el.id || null,
      href: tag === 'a' ? (el as HTMLAnchorElement).href : null,
      isSubmit,
      formIndex: form ? forms.indexOf(form) : -1,
      landmark: el.closest('nav, header, [role=navigation], [role=banner], [role=menubar]') !== null,
      dialogTitle: dialog ? norm(dialog.getAttribute('aria-label')) || byIds(dialog.getAttribute('aria-labelledby')) || textOf(dialog.querySelector('h1,h2,h3')) : null,
      containerText: textOf(container).slice(0, 2000),
      row,
    });
  }

  const rawForms: RawForm[] = forms.filter(visible).map((f) => {
    const fields: RawField[] = [];
    for (const el of Array.from(f.querySelectorAll('input, textarea, select'))) {
      if (!visible(el)) continue;
      const tag = el.tagName.toLowerCase() as 'input' | 'textarea' | 'select';
      const input = el as HTMLInputElement;
      const type = tag === 'input' ? (input.type || 'text').toLowerCase() : tag;
      if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type)) continue;
      const maxLength = tag === 'select' ? -1 : (el as HTMLInputElement).maxLength;
      fields.push({
        tag,
        type,
        name: input.name || undefined,
        label: labelOf(el) || undefined,
        placeholder: input.placeholder || undefined,
        pattern: input.pattern || undefined,
        min: input.min || undefined,
        max: input.max || undefined,
        maxLength: maxLength > 0 ? maxLength : undefined,
        options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).map((o) => o.value) : undefined,
        readOnly: input.readOnly || undefined,
        testid: el.getAttribute('data-testid'),
        id: el.id || null,
      });
    }
    return {
      index: forms.indexOf(f),
      id: f.id || null,
      action: f.getAttribute('action'),
      hasPassword: f.querySelector('input[type=password]') !== null,
      fields,
    };
  });
  return { elements, forms: rawForms };
}

export const Candidate = z.object({
  key: z.string(),
  descriptor: LocatorDescriptor,
  kind: z.enum(['link', 'button', 'submit', 'other']),
  role: z.string(),
  name: z.string(),
  testid: z.string().optional(),
  href: z.string().optional(),
  landmark: z.boolean(),
  formIndex: z.number().int(),
  formAction: z.string().optional(),
  dialogTitle: z.string().optional(),
  containerText: z.string(),
  ownedRow: z.boolean(),
});
export type Candidate = z.infer<typeof Candidate>;

export const FormField = z.object({
  descriptor: LocatorDescriptor.optional(),
  tag: z.enum(['input', 'textarea', 'select']),
  type: z.string(),
  name: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  pattern: z.string().optional(),
  min: z.string().optional(),
  max: z.string().optional(),
  maxLength: z.number().optional(),
  options: z.array(z.string()).optional(),
  readOnly: z.boolean().optional(),
});
export const FormInfo = z.object({
  index: z.number().int(),
  id: z.string().optional(),
  action: z.string().optional(),
  isLogin: z.boolean(),
  fields: z.array(FormField),
  submits: z.array(z.string()),
  validationMessages: z.array(z.string()),
});
export type FormField = z.infer<typeof FormField>;
export type FormInfo = z.infer<typeof FormInfo>;

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
/** Drops undefined values so objects satisfy exactOptionalPropertyTypes. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

async function unique(page: Page, options: LocatorDescriptor[]): Promise<LocatorDescriptor | undefined> {
  for (const d of options) {
    if ((await locatorFor(page, d).count()) === 1) return d;
  }
  return undefined;
}

function rowScope(row: NonNullable<RawElement['row']>): LocatorScope[] {
  if (row.hasText === '') return [];
  const scopes: LocatorScope[] = [];
  if (row.testid) scopes.push({ strategy: 'testid', value: row.testid, hasText: row.hasText });
  scopes.push({ strategy: 'role', value: row.role, hasText: row.hasText });
  return scopes;
}

export interface Enumerated {
  candidates: Candidate[];
  forms: FormInfo[];
}

/**
 * Lists the page's candidates in DOM order. In a repeated group (table rows, list items) only the first row
 * and rows showing this run's tag are kept, so a 500-row table does not become 500 candidates.
 */
export async function enumerate(page: Page, runTag: string): Promise<Enumerated> {
  const raw = await page.evaluate(collectInPage, runTag);
  const candidates: Candidate[] = [];
  const keys = new Set<string>();
  const firstRowSeen = new Set<string>();

  for (const el of raw.elements) {
    const facts = { testid: opt(el.testid), role: el.role === 'generic' ? undefined : el.role, name: el.name, id: opt(el.id) };
    let descriptor: LocatorDescriptor | undefined;
    if (el.row?.repeated) {
      const groupKey = `${el.row.testid ?? el.row.role}|${el.testid ?? el.role}|${el.name}`;
      if (!el.row.owned) {
        if (firstRowSeen.has(groupKey)) continue;
        firstRowSeen.add(groupKey);
      }
      // A plain locator that is already unique wins (nav list items are "rows" too); scope to the row only when
      // the element repeats across rows (a "View" link in every table row).
      descriptor = await unique(page, ladder(facts));
      if (!descriptor) {
        const inner = ladder({ ...facts, id: undefined });
        const scoped = rowScope(el.row).flatMap((scope) => inner.map((d) => ({ ...d, scope })));
        descriptor = await unique(page, scoped);
      }
    } else {
      descriptor = await unique(page, ladder(facts));
    }
    if (!descriptor) continue;
    const key = describeLocator(descriptor);
    if (keys.has(key)) continue;
    keys.add(key);
    const form = raw.forms.find((f) => f.index === el.formIndex);
    candidates.push(
      defined({
        key,
        descriptor,
        kind: el.isSubmit ? 'submit' : el.role === 'link' ? 'link' : el.role === 'button' ? 'button' : 'other',
        role: el.role,
        name: el.name,
        testid: opt(el.testid),
        href: opt(el.href),
        landmark: el.landmark,
        formIndex: el.formIndex,
        formAction: form ? opt(form.action) ?? opt(form.id) : undefined,
        dialogTitle: opt(el.dialogTitle),
        containerText: el.containerText,
        ownedRow: el.row?.owned ?? false,
      }) as Candidate,
    );
  }

  const forms: FormInfo[] = [];
  for (const f of raw.forms) {
    const fields: FormField[] = [];
    for (const field of f.fields) {
      const descriptor = await unique(
        page,
        ladder({ testid: opt(field.testid), label: field.label, placeholder: field.placeholder, id: opt(field.id) }),
      );
      const { testid: _t, id: _i, ...facts } = field;
      fields.push(defined({ ...facts, descriptor }) as FormField);
    }
    forms.push(
      defined({
        index: f.index,
        id: opt(f.id),
        action: opt(f.action),
        isLogin: f.hasPassword,
        fields,
        submits: candidates.filter((c) => c.kind === 'submit' && c.formIndex === f.index).map((c) => c.name),
        validationMessages: [],
      }) as FormInfo,
    );
  }
  return { candidates, forms };
}

/** Visible validation feedback: alerts, aria-invalid fields' descriptions, and native validation messages. */
export async function validationMessages(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
    for (const el of Array.from(document.querySelectorAll('[role=alert], [aria-live=assertive]'))) {
      const t = el instanceof HTMLElement && el.getClientRects().length > 0 ? norm(el.innerText) : '';
      if (t) out.add(t);
    }
    for (const el of Array.from(document.querySelectorAll('[aria-invalid=true]'))) {
      for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
        const t = norm(document.getElementById(id)?.textContent);
        if (t) out.add(t);
      }
    }
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      const msg = (el as HTMLInputElement).validationMessage;
      if (msg && (el as HTMLInputElement).willValidate && !(el as HTMLInputElement).checkValidity()) out.add(norm(msg));
    }
    return [...out].slice(0, 20);
  });
}

export const TextElement = z.object({ testid: z.string(), text: z.string() });
export type TextElement = z.infer<typeof TextElement>;

/** Visible, non-interactive [data-testid] elements with short text: what a screen *shows* (balances, statuses). */
export async function textElements(page: Page): Promise<TextElement[]> {
  return page.evaluate(() => {
    const out: { testid: string; text: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid]'))) {
      if (el.matches('a, button, input, select, textarea, table, tr, form')) continue;
      if (el.querySelector('a, button, input, select, textarea')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = (el instanceof HTMLElement ? el.innerText : (el.textContent ?? '')).replace(/\s+/g, ' ').trim();
      if (text !== '' && text.length <= 60) out.push({ testid: el.getAttribute('data-testid') ?? '', text });
    }
    return out;
  });
}

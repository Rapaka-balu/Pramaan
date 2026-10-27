// Locator descriptors on the §2.2 ladder: data-testid → role → label → placeholder → CSS #id.
import type { Locator, Page } from '@playwright/test';
import { z } from 'zod';

export const LocatorStrategy = z.enum(['testid', 'role', 'label', 'placeholder', 'css-id']);
export const LocatorScope = z.object({
  strategy: z.enum(['testid', 'role']),
  value: z.string(),
  hasText: z.string(),
});
export const LocatorDescriptor = z.object({
  strategy: LocatorStrategy,
  value: z.string(),
  name: z.string().optional(),
  /** Repeated containers (table rows): scope to the one row whose text contains hasText. */
  scope: LocatorScope.optional(),
});
export type LocatorDescriptor = z.infer<typeof LocatorDescriptor>;
export type LocatorScope = z.infer<typeof LocatorScope>;

export interface ElementFacts {
  testid?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
  id?: string | undefined;
}

// Ids that look generated (react-select-3-input, :r1:, ember123) are not stable enough for a locator.
const STABLE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const GENERATED_ID = /\d{3,}|^(ember|react|radix|mui|headlessui)[-_]?/i;

/** Every applicable rung, best first. The caller keeps the first that resolves to exactly one element. */
export function ladder(f: ElementFacts): LocatorDescriptor[] {
  const out: LocatorDescriptor[] = [];
  const name = f.name?.replace(/\s+/g, ' ').trim();
  if (f.testid) out.push({ strategy: 'testid', value: f.testid });
  if (f.role && name) out.push({ strategy: 'role', value: f.role, name });
  if (f.label?.trim()) out.push({ strategy: 'label', value: f.label.trim() });
  if (f.placeholder?.trim()) out.push({ strategy: 'placeholder', value: f.placeholder.trim() });
  if (f.id && STABLE_ID.test(f.id) && !GENERATED_ID.test(f.id)) out.push({ strategy: 'css-id', value: f.id });
  return out;
}

/** Stable string form, used as the candidate key in frontier, transitions and summaries. */
export function describeLocator(d: LocatorDescriptor): string {
  const base = d.name !== undefined ? `${d.strategy}:${d.value}[${d.name}]` : `${d.strategy}:${d.value}`;
  return d.scope ? `${d.scope.strategy}:${d.scope.value}{${d.scope.hasText}} >> ${base}` : base;
}

type AriaRole = Parameters<Page['getByRole']>[0];
type Root = Pick<Page, 'getByTestId' | 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'locator'>;

function rung(root: Root, d: Pick<LocatorDescriptor, 'strategy' | 'value' | 'name'>): Locator {
  switch (d.strategy) {
    case 'testid':
      return root.getByTestId(d.value);
    case 'role':
      return root.getByRole(d.value as AriaRole, d.name !== undefined ? { name: d.name, exact: true } : {});
    case 'label':
      return root.getByLabel(d.value, { exact: true });
    case 'placeholder':
      return root.getByPlaceholder(d.value, { exact: true });
    case 'css-id':
      return root.locator(`[id="${d.value.replace(/"/g, '\\"')}"]`);
  }
}

export function locatorFor(page: Page, d: LocatorDescriptor): Locator {
  if (!d.scope) return rung(page, d);
  const container = rung(page, { strategy: d.scope.strategy, value: d.scope.value }).filter({ hasText: d.scope.hasText });
  return rung(container, d);
}

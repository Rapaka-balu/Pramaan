// Form fill (§8 M2): deterministic en_IN values chosen by label and type. Only free-text gets the run tag.
import { Faker, en_IN, en } from '@faker-js/faker';
import { istDatePlus } from '../core/time.js';

export interface FieldFacts {
  tag: 'input' | 'textarea' | 'select';
  type: string; // lower-cased input type; 'textarea' / 'select' for those tags
  name?: string | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
  pattern?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  maxLength?: number | undefined;
  options?: string[] | undefined; // select option values, in order
  readOnly?: boolean | undefined;
}

export type FieldValue =
  | { kind: 'fill'; value: string; tagged: boolean }
  | { kind: 'select'; value: string }
  | { kind: 'skip'; reason: string };

// A label, name or placeholder carrying one of these is a formatted field: never tagged, filled by the factory.
const HINTS: [RegExp, string][] = [
  [/e-?mail/i, 'email'],
  [/phone|mobile|\btel\b|contact\s*no/i, 'phone'],
  [/\b(dob|date|day of)\b|birth/i, 'date'],
  [/pin\s*code|zip|postal/i, 'pincode'],
  [/\bpan\b/i, 'pan'],
  [/aadha?ar/i, 'aadhaar'],
  [/ifsc/i, 'ifsc'],
  [/amount|salary|price|ctc|\bqty\b|quantity|\bage\b|\byear\b|\bdays?\b|\bhours?\b|count|number|\bno\.?$/i, 'number'],
  [/otp|\bcode\b/i, 'code'],
  [/url|website/i, 'url'],
  [/account/i, 'number'],
];
const FREE_TEXT_TYPES = new Set(['text', '', 'search']);

function hintOf(f: FieldFacts): string | undefined {
  const text = [f.label, f.name, f.placeholder].filter(Boolean).join(' ');
  return HINTS.find(([re]) => re.test(text))?.[1];
}

/** §2.3 #5: a textarea, or a text input with no format hint and no pattern attribute. */
export function isFreeText(f: FieldFacts): boolean {
  if (f.tag === 'textarea') return true;
  if (f.tag !== 'input' || !FREE_TEXT_TYPES.has(f.type)) return false;
  return !f.pattern && hintOf(f) === undefined;
}

export interface FillContext {
  runTag: string;
  faker: Faker;
  now?: Date;
}

/** One faker per run, seeded from the run id, so a crawl's form data is reproducible. */
export function runFaker(runId: string): Faker {
  const faker = new Faker({ locale: [en_IN, en] });
  let h = 0;
  for (const c of runId) h = (h * 31 + c.charCodeAt(0)) | 0;
  faker.seed(Math.abs(h));
  return faker;
}

function clip(v: string, max: number | undefined): string {
  return max !== undefined && max > 0 ? v.slice(0, max) : v;
}

function isEndDate(f: FieldFacts): boolean {
  return /\b(to|end|until|till)\b|_to$|^to/i.test([f.label, f.name].filter(Boolean).join(' '));
}

function numberIn(f: FieldFacts): string {
  const min = f.min !== undefined && f.min !== '' ? Number(f.min) : undefined;
  const max = f.max !== undefined && f.max !== '' ? Number(f.max) : undefined;
  let v = 1;
  if (min !== undefined && Number.isFinite(min) && v < min) v = min;
  if (max !== undefined && Number.isFinite(max) && v > max) v = max;
  return String(v);
}

export function valueFor(f: FieldFacts, ctx: FillContext): FieldValue {
  const now = ctx.now ?? new Date();
  if (f.readOnly) return { kind: 'skip', reason: 'read-only' };
  if (f.tag === 'select') {
    const opt = (f.options ?? []).find((o) => o !== '');
    return opt !== undefined ? { kind: 'select', value: opt } : { kind: 'skip', reason: 'no options' };
  }
  switch (f.type) {
    case 'password':
      return { kind: 'skip', reason: 'password field' };
    case 'checkbox':
    case 'radio':
    case 'file':
    case 'hidden':
    case 'submit':
    case 'button':
    case 'reset':
    case 'image':
      return { kind: 'skip', reason: `${f.type} input` };
    case 'date':
      return { kind: 'fill', value: istDatePlus(isEndDate(f) ? 8 : 7, now), tagged: false };
    case 'datetime-local':
      return { kind: 'fill', value: `${istDatePlus(isEndDate(f) ? 8 : 7, now)}T10:00`, tagged: false };
    case 'time':
      return { kind: 'fill', value: '10:00', tagged: false };
    case 'month':
      return { kind: 'fill', value: istDatePlus(31, now).slice(0, 7), tagged: false };
    case 'number':
    case 'range':
      return { kind: 'fill', value: numberIn(f), tagged: false };
    case 'email':
      return { kind: 'fill', value: ctx.faker.internet.email({ provider: 'example.in' }).toLowerCase(), tagged: false };
    case 'tel':
      return { kind: 'fill', value: `+91 9${ctx.faker.string.numeric(9)}`, tagged: false };
    case 'url':
      return { kind: 'fill', value: 'https://example.in/', tagged: false };
  }
  if (isFreeText(f)) {
    return { kind: 'fill', value: clip(`${ctx.runTag}-${ctx.faker.lorem.words(3)}`, f.maxLength), tagged: true };
  }
  const v = ((): string => {
    switch (hintOf(f)) {
      case 'email':
        return ctx.faker.internet.email({ provider: 'example.in' }).toLowerCase();
      case 'phone':
        return `9${ctx.faker.string.numeric(9)}`;
      case 'date':
        return istDatePlus(7, now).split('-').reverse().join('/'); // DD/MM/YYYY for text date fields
      case 'pincode':
        return '560001';
      case 'pan':
        return `${ctx.faker.string.alpha({ length: 5, casing: 'upper' })}${ctx.faker.string.numeric(4)}Z`;
      case 'aadhaar':
        return `0${ctx.faker.string.numeric(11)}`; // leading 0: never a valid Aadhaar
      case 'ifsc':
        return 'PRMQ0000001';
      case 'number':
        return numberIn(f);
      case 'url':
        return 'https://example.in/';
      default:
        return ctx.faker.string.alphanumeric({ length: 6, casing: 'upper' });
    }
  })();
  return { kind: 'fill', value: clip(v, f.maxLength), tagged: false };
}

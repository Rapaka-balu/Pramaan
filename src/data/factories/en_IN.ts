// en_IN test-data factories (§8 M7): Indian names, +91 mobiles, IST dates, and PAN / Aadhaar values that are
// *format-valid but can never be real* — PAN with an unused holder-type letter, Aadhaar failing its Verhoeff check.
import type { Faker } from '@faker-js/faker';
import { istDatePlus } from '../../core/time.js';
import type { JsonSchema } from '../../spec/schema-infer.js';

// ---------------------------------------------------------------- Verhoeff (Aadhaar check digit)
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
/** True when the digit string passes the Verhoeff checksum (real Aadhaar numbers do). */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => {
    c = D[c]?.[P[i % 8]?.[Number(ch)] ?? 0] ?? 0;
  });
  return c === 0;
}

// PAN 4th letter = holder type; real ones are one of P C H F A T B L J G. Any other letter is never issued.
const PAN_TYPES = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);
export const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const isRealPanType = (pan: string): boolean => PAN_TYPES.has(pan.charAt(3));

export interface Factory {
  name(): string;
  firstName(): string;
  lastName(): string;
  email(): string;
  mobile(): string; // "+91 9XXXXXXXXX"
  pan(): string; // format-valid, never a real holder type
  aadhaar(): string; // 12 digits, first 2–9, Verhoeff-invalid
  ifsc(): string;
  pincode(): string;
  dateIst(offsetDays: number, now?: Date): string; // YYYY-MM-DD
  freeText(runTag: string, maxLength?: number): string;
}

export function enInFactory(faker: Faker): Factory {
  const upper = (n: number): string => faker.string.alpha({ length: n, casing: 'upper' });
  return {
    name: () => `${faker.person.firstName()} ${faker.person.lastName()}`,
    firstName: () => faker.person.firstName(),
    lastName: () => faker.person.lastName(),
    email: () => faker.internet.email({ provider: 'example.in' }).toLowerCase(),
    mobile: () => `+91 ${faker.helpers.arrayElement(['9', '8', '7', '6'])}${faker.string.numeric(9)}`,
    pan: () => {
      const notReal = [...'DEIKMNOQRSUVWXYZ'];
      return `${upper(3)}${faker.helpers.arrayElement(notReal)}${upper(1)}${faker.string.numeric(4)}${upper(1)}`;
    },
    aadhaar: () => {
      for (;;) {
        const n = `${faker.number.int({ min: 2, max: 9 })}${faker.string.numeric(11)}`;
        if (!verhoeffValid(n)) return n;
      }
    },
    ifsc: () => `PRMQ0${faker.string.numeric(6)}`,
    pincode: () => `${faker.number.int({ min: 1, max: 8 })}${faker.string.numeric(5)}`,
    dateIst: (offset, now) => istDatePlus(offset, now),
    freeText: (runTag, maxLength) => {
      const v = `${runTag}-${faker.lorem.words(3)}`;
      return maxLength !== undefined && maxLength > 0 ? v.slice(0, maxLength) : v;
    },
  };
}

const NAME_RULES: [RegExp, (f: Factory, runTag: string) => unknown][] = [
  [/^(e-?mail|email_?address)$/i, (f) => f.email()],
  [/(mobile|phone|contact_?no)/i, (f) => f.mobile()],
  [/(^|_)pan(_|$)|panNumber/i, (f) => f.pan()],
  [/aadha?ar/i, (f) => f.aadhaar()],
  [/ifsc/i, (f) => f.ifsc()],
  [/(pin_?code|zip|postal)/i, (f) => f.pincode()],
  [/^(first_?name|given_?name)$/i, (f) => f.firstName()],
  [/^(last_?name|surname|family_?name)$/i, (f) => f.lastName()],
  [/^(name|full_?name|employee_?name)$/i, (f) => f.name()],
];

/**
 * A create body for an entity: starts from an observed body (a known-valid shape), then refreshes the values a
 * reuse would make wrong or personal — free text gets this run's tag, dates move to an IST window, names/phones/
 * IDs come from the factory. Unknown fields keep their observed value.
 */
export function buildBody(
  schema: JsonSchema | undefined,
  recipe: Record<string, unknown>,
  ctx: { factory: Factory; runTag: string; tagPrefix: string; dateOffset: number; now?: Date },
): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = { ...recipe };
  const dateKeys = Object.entries(props).filter(([, s]) => s.format === 'date').map(([k]) => k);
  for (const [k, v] of Object.entries(recipe)) {
    const rule = NAME_RULES.find(([re]) => re.test(k));
    if (typeof v === 'string' && v.startsWith(`${ctx.tagPrefix}-`)) out[k] = ctx.factory.freeText(ctx.runTag);
    else if (dateKeys.includes(k)) {
      // start and end on the same IST day: a one-day request is valid in every leave-like workflow
      out[k] = ctx.factory.dateIst(ctx.dateOffset, ctx.now);
    } else if (rule && typeof v === 'string') out[k] = rule[1](ctx.factory, ctx.runTag);
  }
  return out;
}

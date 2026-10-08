// PII / secret redaction (§2.3 #7). Runs before anything reaches an LLM, a log, or the suite repo.

const HEADER_KEY = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;
const SECRET_KEY = /pass(word)?|secret|token/i;
const SALARY_KEY = /salary|ctc|basic|gross|net_?pay|pay(roll)?_amount/i;
const ACCOUNT_KEY = /account|acct|bank/i;

const tok = (kind: string): string => `[REDACTED:${kind}]`;

// Order matters: explicit-prefix phones before Aadhaar (so +91XXXXXXXXXX is not read as 12 digits),
// Aadhaar before bare phones (so a 12-digit run is not partially read as a phone).
const TEXT_RULES: readonly (readonly [RegExp, string | ((...m: string[]) => string)])[] = [
  [/^((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)([ \t]*:[ \t]*).+$/gim, (_m, k, sep) => `${k}${sep}${tok('auth')}`],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_m, scheme) => `${scheme} ${tok('token')}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, tok('jwt')],
  // "password": "x", password=x, token: x  (raw bodies, query strings, header dumps)
  [
    /\b([\w-]*(?:pass(?:word)?|secret|token)[\w-]*)(["']?\s*[:=]\s*["']?)(?!\d+(?:[\s"',;&}]|$))([^"'&\s,;}]+)/gi,
    (_m, k, sep) => `${k}${sep}${tok('secret')}`,
  ],
  [/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, tok('pan')],
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, tok('ifsc')],
  [/(?<![\w+])\+91[ -]?[6-9]\d{4}[ -]?\d{5}(?!\d)/g, tok('phone')],
  [/(?<![\w+])\+91[ -]?[6-9]\d{2}[ -]?\d{3}[ -]?\d{4}(?!\d)/g, tok('phone')],
  [/(?<![\w-])(?:\d{12}|\d{4}([ -])\d{4}\1\d{4})(?![\w]|-\d)/g, tok('aadhaar')],
  [/(?<![\w+-])(?:(?:91|0)[ -]?)?[6-9]\d{4}[ -]?\d{5}(?![\w]|-\d)/g, tok('phone')],
  [/(?<![\w+-])(?:(?:91|0)[ -]?)?[6-9]\d{2}[ -]?\d{3}[ -]?\d{4}(?![\w]|-\d)/g, tok('phone')],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of TEXT_RULES) {
    out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep as (...m: string[]) => string);
  }
  return out;
}

const ACCOUNT_DIGITS = /(?<!\d)\d{9,18}(?!\d)/g;

function redactAccount(v: unknown): unknown {
  if (typeof v === 'number' || typeof v === 'bigint') {
    return /^\d{9,18}$/.test(String(v)) ? tok('account') : v;
  }
  if (typeof v === 'string') return redactText(v.replace(ACCOUNT_DIGITS, tok('account')));
  return undefined; // not a leaf
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

type Ctx = { account: boolean };

// Decides a value by its key. Returns undefined when the key carries no rule.
function byKey(key: string, value: unknown, ctx: Ctx): { value: unknown } | undefined {
  if (HEADER_KEY.test(key)) return { value: value == null ? value : tok('auth') };
  if (SECRET_KEY.test(key) && typeof value === 'string') return { value: tok('secret') };
  if (SALARY_KEY.test(key) && value != null) return { value: tok('salary') };
  if (ACCOUNT_KEY.test(key)) return { value: walk(value, { ...ctx, account: true }) };
  return undefined;
}

function walk(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') return ctx.account ? redactAccount(value) : redactText(value);
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (ctx.account) return redactAccount(value);
    const d = String(value);
    if (/^\d{12}$/.test(d)) return tok('aadhaar');
    if (/^[6-9]\d{9}$/.test(d)) return tok('phone');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx));
  if (!isPlainObject(value)) return value;

  // HAR-style {name, value} pairs (headers, queryString, postData.params)
  const name = value['name'];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'value' && typeof name === 'string') {
      const decided = byKey(name, v, ctx);
      if (decided) {
        out[k] = decided.value;
        continue;
      }
    }
    const decided = byKey(k, v, ctx);
    out[k] = decided ? decided.value : walk(v, ctx);
  }
  return out;
}

/** Deep, non-mutating redaction. Plain objects and arrays are copied; strings run through redactText. */
export function redact<T>(value: T): T {
  return walk(value, { account: false }) as T;
}

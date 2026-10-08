// Target guard (§2.3 #1): only allow-listed origins; forbidden host patterns always win.

export class TargetGuardError extends Error {
  override name = 'TargetGuardError';
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export interface TargetGuard {
  check(url: string): GuardResult;
  assertAllowed(url: string): void;
}

export function createTargetGuard(safety: { allowedOrigins: string[]; forbiddenHostPatterns: string[] }): TargetGuard {
  const allowed = new Set<string>();
  for (const o of safety.allowedOrigins) {
    try {
      allowed.add(new URL(o).origin);
    } catch {
      throw new TargetGuardError(`invalid allowedOrigin: ${o}`);
    }
  }
  const forbidden = safety.forbiddenHostPatterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      throw new TargetGuardError(`invalid forbiddenHostPattern: ${p}`);
    }
  });

  const check = (url: string): GuardResult => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: `malformed URL: ${url}` };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: `non-http(s) scheme refused: ${u.protocol}` };
    }
    const hit = forbidden.find((re) => re.test(u.hostname));
    if (hit) return { ok: false, reason: `host ${u.hostname} matches forbidden pattern ${hit.source}` };
    if (!allowed.has(u.origin)) return { ok: false, reason: `origin ${u.origin} is not in safety.allowedOrigins` };
    return { ok: true };
  };

  return {
    check,
    assertAllowed(url: string): void {
      const r = check(url);
      if (!r.ok) throw new TargetGuardError(r.reason);
    },
  };
}

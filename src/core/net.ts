// The one path for non-browser HTTP: target guard → rate limiter → fetch with timeout.

export interface Http {
  request(url: string, init?: RequestInit): Promise<Response>;
  readonly calls: number;
}

export function createHttp(opts: {
  guard: { assertAllowed(url: string): void };
  limiter?: { acquire(): Promise<void> };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Http {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    async request(url: string, init?: RequestInit): Promise<Response> {
      opts.guard.assertAllowed(url);
      if (opts.limiter) await opts.limiter.acquire();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      calls++;
      return fetchImpl(url, { ...init, signal });
    },
  };
}

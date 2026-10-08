import { describe, expect, it } from 'vitest';
import { createHttp } from '../../src/core/net.js';
import { TargetGuardError, createTargetGuard } from '../../src/core/target-guard.js';

const guard = createTargetGuard({ allowedOrigins: ['http://localhost:4600'], forbiddenHostPatterns: [] });

function stubFetch(): { fetchImpl: typeof fetch; seen: { url: string; init: RequestInit | undefined }[] } {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('createHttp', () => {
  it('passes allowed requests through with a timeout signal', async () => {
    const { fetchImpl, seen } = stubFetch();
    const http = createHttp({ guard, fetchImpl, timeoutMs: 1000 });
    const res = await http.request('http://localhost:4600/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(http.calls).toBe(1);
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.init?.method).toBe('GET');
  });

  it('refuses disallowed targets before fetching or acquiring', async () => {
    const { fetchImpl, seen } = stubFetch();
    let acquired = 0;
    const http = createHttp({ guard, fetchImpl, limiter: { acquire: () => Promise.resolve(void acquired++) } });
    await expect(http.request('http://hrms.blgtechnologies.in/')).rejects.toBeInstanceOf(TargetGuardError);
    expect(seen).toHaveLength(0);
    expect(acquired).toBe(0);
    expect(http.calls).toBe(0);
  });

  it('acquires the limiter before each fetch', async () => {
    const order: string[] = [];
    const fetchImpl = (() => {
      order.push('fetch');
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    const http = createHttp({ guard, fetchImpl, limiter: { acquire: () => Promise.resolve(void order.push('acquire')) } });
    await http.request('http://localhost:4600/a');
    await http.request('http://localhost:4600/b');
    expect(order).toEqual(['acquire', 'fetch', 'acquire', 'fetch']);
  });
});

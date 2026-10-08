import { describe, expect, it } from 'vitest';
import { createRateLimiter, type Clock } from '../../src/core/rate-limit.js';

function fakeClock(start = 1_000_000): Clock & { t: number; sleeps: number[] } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
      return Promise.resolve();
    },
  };
  return c;
}

describe('rate limiter', () => {
  it('spaces acquisitions 1000/rps ms apart', async () => {
    const clock = fakeClock();
    const lim = createRateLimiter(2, clock);
    const times: number[] = [];
    await Promise.all([0, 1, 2, 3].map(() => lim.acquire().then(() => times.push(clock.t))));
    expect(times).toEqual([1_000_000, 1_000_500, 1_001_000, 1_001_500]);
  });

  it('never exceeds rps within any 1s window', async () => {
    const clock = fakeClock();
    const lim = createRateLimiter(3, clock);
    const times: number[] = [];
    await Promise.all(Array.from({ length: 10 }, () => lim.acquire().then(() => times.push(clock.t))));
    for (const t of times) expect(times.filter((x) => x >= t && x < t + 1000).length).toBeLessThanOrEqual(3);
  });

  it('does not sleep when calls are already spaced out', async () => {
    const clock = fakeClock();
    const lim = createRateLimiter(1, clock);
    await lim.acquire();
    clock.t += 5000;
    await lim.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('schedule runs fn after acquiring and returns its result; errors do not jam the queue', async () => {
    const clock = fakeClock();
    const lim = createRateLimiter(10, clock);
    await expect(lim.schedule(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(lim.schedule(() => Promise.resolve(42))).resolves.toBe(42);
    expect(clock.sleeps).toEqual([100]);
  });

  it('rejects invalid rps', () => {
    expect(() => createRateLimiter(0)).toThrow(RangeError);
  });
});

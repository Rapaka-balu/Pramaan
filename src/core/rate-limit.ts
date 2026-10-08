// Spacing limiter (§2.3 #4): acquisitions are serialized at least 1000/rps ms apart.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RateLimiter {
  acquire(): Promise<void>;
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createRateLimiter(rps: number, clock: Clock = realClock): RateLimiter {
  if (!Number.isFinite(rps) || rps <= 0) throw new RangeError(`rate limiter: invalid rps ${rps}`);
  const interval = 1000 / rps;
  let nextAt = Number.NEGATIVE_INFINITY;
  let tail: Promise<void> = Promise.resolve();

  const acquire = (): Promise<void> => {
    const slot = tail.then(async () => {
      const wait = nextAt - clock.now();
      if (wait > 0) await clock.sleep(wait);
      nextAt = Math.max(clock.now(), nextAt) + interval;
    });
    tail = slot.catch(() => undefined);
    return slot;
  };

  return {
    acquire,
    async schedule<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      return fn();
    },
  };
}

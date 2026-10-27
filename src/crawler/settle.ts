// Settling without hard waits: an action is done when no request is in flight across two animation frames.
import type { Page } from '@playwright/test';

export interface InflightTracker {
  readonly inflight: number;
  /** Resolves when the count reaches 0, or after maxMs (bounded, event-driven). */
  idle(maxMs: number): Promise<void>;
}

export function trackInflight(page: Page): InflightTracker {
  let inflight = 0;
  let waiters: (() => void)[] = [];
  const done = (): void => {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    }
  };
  page.on('request', () => {
    inflight += 1;
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    get inflight() {
      return inflight;
    },
    idle(maxMs: number): Promise<void> {
      if (inflight === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, maxMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

const twoFrames = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Waits for DOM ready, then until the network is quiet across two frames (max `timeoutMs`). */
export async function settle(page: Page, tracker: InflightTracker, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  let quiet = 0;
  while (Date.now() < end && quiet < 2) {
    try {
      await page.evaluate(twoFrames);
    } catch {
      // the page navigated mid-evaluate: wait for the new document
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, end - Date.now()) }).catch(() => undefined);
      quiet = 0;
      continue;
    }
    if (tracker.inflight === 0) quiet += 1;
    else {
      quiet = 0;
      await tracker.idle(Math.max(1, end - Date.now()));
    }
  }
}

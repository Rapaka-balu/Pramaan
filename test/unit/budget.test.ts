import { describe, expect, it } from 'vitest';
import { Budget, BudgetExceeded } from '../../src/core/budget.js';

describe('Budget', () => {
  it('tracks spent and remaining', () => {
    const b = new Budget(5, 'perCommand');
    b.charge(1.25);
    b.charge(0.75);
    expect(b.spent).toBeCloseTo(2);
    expect(b.remaining).toBeCloseTo(3);
  });

  it('allows spending exactly up to the cap (with float tolerance)', () => {
    const b = new Budget(0.3, 'x');
    b.charge(0.1);
    b.charge(0.2);
    expect(b.remaining).toBeCloseTo(0);
  });

  it('wouldExceed predicts without charging', () => {
    const b = new Budget(1, 'x');
    expect(b.wouldExceed(1)).toBe(false);
    expect(b.wouldExceed(1.01)).toBe(true);
    expect(b.spent).toBe(0);
  });

  it('throws BudgetExceeded when a charge passes the cap, still counting the spend', () => {
    const b = new Budget(1, 'compile');
    b.charge(0.9);
    let err: unknown;
    try {
      b.charge(0.2);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect((err as BudgetExceeded).label).toBe('compile');
    expect((err as BudgetExceeded).message).toMatch(/compile/);
    expect(b.spent).toBeCloseTo(1.1);
    expect(b.remaining).toBe(0);
  });

  it('a zero cap rejects any positive charge but allows $0', () => {
    const b = new Budget(0, 'x');
    expect(() => b.charge(0)).not.toThrow();
    expect(() => b.charge(0.0001)).toThrow(BudgetExceeded);
  });

  it('rejects negative or NaN charges and caps', () => {
    expect(() => new Budget(-1, 'x')).toThrow(RangeError);
    const b = new Budget(1, 'x');
    expect(() => b.charge(-1)).toThrow(RangeError);
    expect(() => b.charge(Number.NaN)).toThrow(RangeError);
  });
});

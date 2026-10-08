// USD budget caps (§2.4): budgets.perCommandUsd / budgets.compileUsd.

export class BudgetExceeded extends Error {
  override name = 'BudgetExceeded';
  constructor(
    readonly label: string,
    readonly capUsd: number,
    readonly spentUsd: number,
  ) {
    super(`budget "${label}" exceeded: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} cap`);
  }
}

export class Budget {
  private spentUsd = 0;

  constructor(
    readonly capUsd: number,
    readonly label: string,
  ) {
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new RangeError(`budget "${label}": invalid cap ${capUsd}`);
  }

  get spent(): number {
    return this.spentUsd;
  }

  get remaining(): number {
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  wouldExceed(usd: number): boolean {
    return this.spentUsd + usd > this.capUsd + 1e-9;
  }

  /** Records the spend (money already spent stays counted), then throws if the cap is now exceeded. */
  charge(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`budget "${this.label}": invalid charge ${usd}`);
    const over = this.wouldExceed(usd);
    this.spentUsd += usd;
    if (over) throw new BudgetExceeded(this.label, this.capUsd, this.spentUsd);
  }
}

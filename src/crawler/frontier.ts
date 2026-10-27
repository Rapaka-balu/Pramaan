// BFS frontier (§8 M2): unvisited route first, then navigation landmarks, then form submits, then the rest,
// and owned-record actions (cancel, approve…) last, because they change the state the others start from.
// Ties keep insertion order, so the crawl is deterministic. The LLM rerank is off in keyless mode (D-010).

export interface FrontierItem {
  stateKey: string;
  candidateKey: string;
  kind: 'link' | 'button' | 'submit' | 'other';
  /** Normalized route a link points at, when known. */
  targetRoute?: string | undefined;
  landmark: boolean; // inside nav / banner / menubar
  /** Changes server state (owned-record action): explored after everything else in its state. */
  mutating?: boolean | undefined;
  depth: number;
}

export function priority(item: FrontierItem, visitedRoutes: ReadonlySet<string>): number {
  if (item.mutating) return 4;
  if (item.targetRoute !== undefined && !visitedRoutes.has(item.targetRoute)) return 0;
  if (item.landmark) return 1;
  if (item.kind === 'submit') return 2;
  return 3;
}

export class Frontier {
  private items: { item: FrontierItem; seq: number }[] = [];
  private seen = new Set<string>();
  private seq = 0;

  /** Adds an item once per (state, candidate). Returns false if it was already queued or explored. */
  push(item: FrontierItem): boolean {
    const id = `${item.stateKey}|${item.candidateKey}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.items.push({ item, seq: this.seq++ });
    return true;
  }

  pop(visitedRoutes: ReadonlySet<string>): FrontierItem | undefined {
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    this.items.forEach(({ item }, i) => {
      const p = priority(item, visitedRoutes);
      if (p < bestScore) {
        bestScore = p;
        best = i;
      }
    });
    if (best < 0) return undefined;
    return this.items.splice(best, 1)[0]?.item;
  }

  get size(): number {
    return this.items.length;
  }
}

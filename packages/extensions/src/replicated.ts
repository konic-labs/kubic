// Replicated state: coarse latest-value cells with snapshot-then-updates
// and delta catch-up (issue #37; §32). Readers take a snapshot, then replay
// updates since the snapshot version — the stream is gapless by
// construction (contiguous from/to). Disconnect clears readiness and drops
// buffered deltas; only a fresh snapshot re-arms the cell.

export interface CellSnapshot<T> {
  version: number;
  value: T;
}

export interface CellDelta<T> {
  from: number;
  to: number;
  value: T;
}

export class ReplicatedCell<T> {
  private version = 1;
  private value: T;
  private history: CellDelta<T>[] = [];
  private listeners = new Set<(delta: CellDelta<T>) => void>();
  ready = true;

  constructor(initial: T) {
    this.value = initial;
  }

  set(next: T): CellDelta<T> {
    const delta: CellDelta<T> = {
      from: this.version,
      to: this.version + 1,
      value: next,
    };
    this.version += 1;
    this.value = next;
    this.history.push(delta);
    for (const listener of [...this.listeners]) listener(delta);
    return delta;
  }

  latest(): T {
    return this.value;
  }

  snapshot(): CellSnapshot<T> {
    return { version: this.version, value: this.value };
  }

  updatesSince(version: number): CellDelta<T>[] {
    if (!this.ready) return [];
    return this.history.filter((delta) => delta.to > version);
  }

  applyDelta(delta: CellDelta<T>): void {
    if (!this.ready) return;
    if (delta.to !== this.version + 1) {
      throw new Error(
        `non-contiguous delta: cell at v${this.version}, delta targets v${delta.to}`,
      );
    }
    this.version = delta.to;
    this.value = delta.value;
    this.history.push(delta);
  }

  subscribe(listener: (delta: CellDelta<T>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  disconnect(): void {
    this.ready = false;
    this.history = [];
    this.listeners.clear();
  }
}

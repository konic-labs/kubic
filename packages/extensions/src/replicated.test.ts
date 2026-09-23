// Replicated state: latest-value, snapshot-then-updates, coarse cells,
// deltas; disconnect clears readiness (issue #37; §32). RED first.
import { describe, expect, it } from 'vitest';
import { ReplicatedCell } from './replicated.js';

describe('replicated state (issue #37, §32)', () => {
  it('keeps the latest value', () => {
    const cell = new ReplicatedCell('a');
    cell.set('b');
    cell.set('c');
    expect(cell.latest()).toBe('c');
  });

  it('is gapless across snapshot-then-updates', () => {
    const cell = new ReplicatedCell('v1');
    cell.set('v2');
    cell.set('v3');
    const snap = cell.snapshot();
    expect(snap.value).toBe('v3');
    const deltas = cell.updatesSince(1);
    expect(deltas.map((d) => d.value)).toEqual(['v2', 'v3']);
    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i].from).toBe(deltas[i - 1].to);
    }
  });

  it('applies deltas onto a lagging cell', () => {
    const a = new ReplicatedCell('v1');
    a.set('v2');
    const b = new ReplicatedCell('v1');
    for (const d of a.updatesSince(1)) b.applyDelta(d);
    expect(b.latest()).toBe('v2');
  });

  it('clears readiness on disconnect', () => {
    const cell = new ReplicatedCell('v1');
    expect(cell.ready).toBe(true);
    cell.disconnect();
    expect(cell.ready).toBe(false);
    expect(cell.updatesSince(0)).toEqual([]);
  });
});

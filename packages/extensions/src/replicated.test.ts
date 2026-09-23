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

// Replicated-cell hardening (issue #69): subscription delivery,
// contiguity enforcement, and post-disconnect silence pinned.
describe('replicated state hardening (issue #69)', () => {
  it('delivers deltas to subscribers and stops after unsubscribe', () => {
    const cell = new ReplicatedCell('v1');
    const seen: string[] = [];
    const unsub = cell.subscribe((delta) => {
      seen.push(delta.value);
    });
    const first = cell.set('v2');
    expect(first).toEqual({ from: 1, to: 2, value: 'v2' });
    cell.set('v3');
    unsub();
    cell.set('v4');
    expect(seen).toEqual(['v2', 'v3']);
  });

  it('rejects non-contiguous deltas with the cell version', () => {
    const cell = new ReplicatedCell('v1');
    try {
      cell.applyDelta({ from: 5, to: 6, value: 'v6' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/non-contiguous/);
      expect((error as Error).message).toMatch(/v1/);
    }
    expect(cell.latest()).toBe('v1');
  });

  it('ignores deltas and updates while disconnected', () => {
    const cell = new ReplicatedCell('v1');
    cell.set('v2');
    cell.disconnect();
    // applyDelta is a silent no-op when not ready — never throws, never lands.
    cell.applyDelta({ from: 2, to: 3, value: 'v3' });
    expect(cell.latest()).toBe('v2');
    expect(cell.updatesSince(0)).toEqual([]);
  });

  it('returns no updates at or behind the current version', () => {
    const cell = new ReplicatedCell('v1');
    cell.set('v2');
    expect(cell.updatesSince(2)).toEqual([]);
    expect(cell.updatesSince(99)).toEqual([]);
    expect(cell.updatesSince(1).map((d) => d.to)).toEqual([2]);
  });

  it('snapshots carry the current version and value', () => {
    const cell = new ReplicatedCell('v1');
    expect(cell.snapshot()).toEqual({ version: 1, value: 'v1' });
    cell.set('v2');
    expect(cell.snapshot()).toEqual({ version: 2, value: 'v2' });
  });
});

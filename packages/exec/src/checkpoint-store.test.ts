import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileCheckpointStore } from './checkpoint-store.js';
import { CHECKPOINT_INTERVAL_MS, type ProcessSnapshot } from './env.js';

function snap(stdout: string): ProcessSnapshot {
  return { exitCode: null, stdout, stderr: '' };
}

describe('file checkpoint store (issue #14, slice B)', () => {
  it('restores snapshots in a new instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const first = new FileCheckpointStore(dir);
    first.recordFinal('op-1', snap('partial output'));
    const second = new FileCheckpointStore(dir);
    expect(second.latest('op-1')?.stdout).toBe('partial output');
  });

  it('throttles unchanged records like the memory store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    let now = 1000;
    const store = new FileCheckpointStore(dir, () => now);
    store.record('op-1', snap('a'));
    now += CHECKPOINT_INTERVAL_MS - 1;
    store.record('op-1', snap('b'));
    expect(store.latest('op-1')?.stdout).toBe('a');
    now += 1;
    store.record('op-1', snap('b'));
    expect(store.latest('op-1')?.stdout).toBe('b');
  });

  it('returns copies and undefined for unknown keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const store = new FileCheckpointStore(dir);
    expect(store.latest('nope')).toBeUndefined();
    store.recordFinal('op-1', snap('x'));
    const hit = store.latest('op-1');
    if (hit) hit.stdout = 'mutated';
    expect(store.latest('op-1')?.stdout).toBe('x');
  });
});

describe('checkpoint hardening (review #14)', () => {
  it('opens cleanly with a corrupt checkpoints file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    writeFileSync(join(dir, 'checkpoints.json'), '{torn json');
    const store = new FileCheckpointStore(dir);
    expect(store.latest('op-1')).toBeUndefined();
    store.recordFinal('op-1', snap('recovered'));
    expect(store.latest('op-1')?.stdout).toBe('recovered');
  });
});

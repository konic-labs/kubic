// Steering answers on the approval card: `c` denies with a comment, `e` edits a
// command before allowing it, `A` approves the turn's edits — each only where
// the host offered it, each behind the arming delay, and the card's input never
// lets typed text reach a decision key.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';

const SHELL = {
  key: 'k1',
  capability: 'destructive-shell',
  toolName: 'bash',
  command: 'rm -rf dist',
  summary: 'rm -rf dist',
  editable: true,
};

const WRITE = {
  key: 'k2',
  capability: 'requires:write',
  toolName: 'write',
  summary: 'write notes.md',
  batchable: true,
};

function type(
  surface: ReturnType<typeof createApprovalSurface>,
  text: string,
): void {
  for (const ch of text) expect(surface.typeInto(ch)).toBe('consumed');
}

describe('deny with a comment', () => {
  it('opens an input and denies with the words', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(SHELL);
    expect(surface.decide('c')).toBe(false);
    expect(surface.inputMode()).toEqual({ kind: 'comment', text: '' });
    // Typed text never reaches a decision key — not even Ctrl-S.
    type(surface, 'use git clean');
    expect(surface.decide('\u0013')).toBe(false);
    expect(surface.typeInto('\r')).toBe('settled');
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'denied by the user: use git clean',
    });
  });

  it('esc goes back to the card; an empty comment is a plain deny', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(SHELL);
    surface.decide('c');
    type(surface, 'x');
    expect(surface.typeInto('\u001b')).toBe('consumed');
    expect(surface.inputMode()).toBeUndefined();
    expect(surface.isShowing()).toBe(true);
    surface.decide('c');
    expect(surface.typeInto('\r')).toBe('settled');
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('bounds the comment', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    void surface.ask(SHELL);
    surface.decide('c');
    surface.typeInto('x'.repeat(2_000));
    expect(surface.inputMode()?.text).toHaveLength(500);
  });
});

describe('edit then allow', () => {
  it('prefills the command and allows the edit', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(SHELL);
    surface.decide('e');
    expect(surface.inputMode()).toEqual({ kind: 'edit', text: 'rm -rf dist' });
    surface.typeInto('\u0015');
    type(surface, 'rm -r dist/cache');
    expect(surface.typeInto('\r')).toBe('settled');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
      edited: { command: 'rm -r dist/cache' },
    });
  });

  it('an unchanged command is a plain allow once; an emptied one stays open', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(SHELL);
    surface.decide('e');
    surface.typeInto('\u0015');
    expect(surface.typeInto('\r')).toBe('consumed');
    expect(surface.isShowing()).toBe(true);
    type(surface, 'rm -rf dist');
    expect(surface.typeInto('\r')).toBe('settled');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('is not offered where the host did not offer it', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    void surface.ask({ ...SHELL, editable: false });
    expect(surface.decide('e')).toBe(false);
    expect(surface.inputMode()).toBeUndefined();
  });
});

describe('allow all edits this turn', () => {
  it('answers an offered ask with the turn batch', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(WRITE);
    expect(surface.decide('A')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-turn-edits',
    });
  });

  it('does nothing on an ask the host did not offer it for', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    void surface.ask({ ...WRITE, batchable: false });
    expect(surface.decide('A')).toBe(false);
    expect(surface.isShowing()).toBe(true);
  });

  it('waits out the arming delay like every other answer', () => {
    let now = 0;
    const surface = createApprovalSurface({
      armingMs: 400,
      quietMs: 600,
      now: () => now,
      setTimer: () => () => {},
    });
    void surface.ask(WRITE);
    now = 100;
    expect(surface.decide('A')).toBe(false);
    expect(surface.decide('c')).toBe(false);
    expect(surface.inputMode()).toBeUndefined();
    now = 2_000;
    expect(surface.decide('A')).toBe(true);
  });
});

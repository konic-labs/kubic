// The approval surface.
//
// Criterion 1's key map is pinned here as pure render/settle tests: there is
// no VirtualTerminal in the pinned pi-tui, so the card is rendered at a fixed
// width (the established pattern in layout.test.ts / tree.test.ts) and the
// surface is exercised with plain strings. The card on the live alt-screen is
// asserted on the composition path.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { renderApprovalCard } from './approval-card.js';
import {
  APPROVAL_CANCELLED_REASON,
  type ApprovalSurface,
  createApprovalSurface,
} from './approval-surface.js';
import type { ApprovalViewRequest } from './approval-view.js';

const REQUEST: ApprovalViewRequest = {
  key: 'k-1',
  capability: 'destructive-shell',
  toolName: 'bash',
  command: 'rm -rf /tmp/x',
  justification: 'clean scratch dir',
};

// The card the app shows for the surface's current ask.
function card(surface: ApprovalSurface, width: number): string {
  const request = surface.pending();
  if (request === undefined) return '';
  return renderApprovalCard(
    createUiTheme(DARK_PALETTE, 'none'),
    request,
    width,
    {
      armed: surface.isArmed(),
      allowable: true,
      keys: surface.keys(),
      commandPage: surface.commandPage(),
      position: 1,
      total: 1,
      explain: true,
      pageKey: 'v',
      explainKey: '?',
    },
  ).join('\n');
}

describe('approval surface: decisions', () => {
  it('resolves allow-once, allow-session and deny by key', async () => {
    for (const [key, expected] of [
      ['a', { approved: true, by: 'allow-once' }],
      ['\x13', { approved: true, by: 'allow-session' }],
      ['d', { approved: false, reason: 'denied by the user' }],
    ] as const) {
      const surface = createApprovalSurface({ armingMs: 0 });
      const pending = surface.ask(REQUEST);
      expect(surface.decide(key)).toBe(true);
      await expect(pending).resolves.toEqual(expected);
      expect(surface.isShowing()).toBe(false);
    }
  });

  it('treats Esc as deny (the approval-view default) without quitting', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(REQUEST);
    expect(surface.decide('\u001b')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('ignores a key that is not a decision instead of settling on it', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(REQUEST);
    expect(surface.decide('z')).toBe(false);
    expect(surface.isShowing()).toBe(true);
    surface.decide('a');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('denies (never hangs) when no decision can arrive', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(REQUEST);
    surface.cancelPending('the session quit before the approval was answered');
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'the session quit before the approval was answered',
    });
    expect(surface.isShowing()).toBe(false);
  });

  it('answers one request at a time: a second ask waits for the first', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-2', toolName: 'write' });
    expect(surface.pending()?.key).toBe('k-1');
    surface.decide('a');
    await expect(first).resolves.toEqual({ approved: true, by: 'allow-once' });
    // The queued request is shown once the first settles.
    expect(surface.pending()?.key).toBe('k-2');
    surface.decide('d');
    await expect(second).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('settles every queued request when the session quits', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-2' });
    surface.cancelPending('quit');
    await expect(first).resolves.toEqual({ approved: false, reason: 'quit' });
    await expect(second).resolves.toEqual({ approved: false, reason: 'quit' });
    expect(surface.isShowing()).toBe(false);
  });
});

describe('approval surface: boot key check', () => {
  it('passes the shipped defaults with zero conflicts', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    expect(surface.checkKeys()).toBe(true);
  });

  it('refuses to arm a conflicting key map by name', () => {
    const surface = createApprovalSurface({
      armingMs: 0,
      keyOverrides: { 'allow-once': ['x'], deny: ['x'] },
    });
    expect(() => surface.checkKeys()).toThrow(/approval key conflict: x/);
  });

  it('reports the documented keys the surface answers to', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    expect(surface.keys()).toEqual({
      'allow-once': ['a'],
      'allow-session': ['ctrl+s'],
      deny: ['d', 'escape'],
      comment: ['c'],
      edit: ['e'],
      'allow-edits': ['shift+a'],
    });
  });
});

describe('approval surface: untrusted content', () => {
  it('sanitizes the request before it reaches a render function', async () => {
    const ESC = '\u001b';
    const BEL = '\u0007';
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask({
      key: 'k',
      capability: `destructive${ESC}[2J-shell`,
      toolName: `bash${BEL}`,
      command: `rm -rf ${ESC}[31m/tmp/x`,
      paths: [`/tmp${ESC}[2J/x`],
      justification: `because${ESC}[0m`,
    });
    const frame = card(surface, 120);
    expect(frame).toContain('destructive');
    expect(frame).toContain('bash');
    expect(frame).toContain('/tmp/x');
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).not.toContain(BEL);
    surface.decide('d');
    await pending;
  });
});

// The asker's own bound can expire while its question is on
// screen (the host service aborts the seat on maxPendingMs). The surface must
// withdraw exactly that ask — not the queue around it — or the obsolete
// question keeps the screen (and blocks the next real ask) while a decision
// pressed later would settle a question nobody is waiting for.
describe('approval surface: an aborted ask is withdrawn', () => {
  const second: ApprovalViewRequest = { ...REQUEST, key: 'k-2' };

  it('withdraws the shown ask, resolves it as cancelled, and shows the next', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const controller = new AbortController();
    const first = surface.ask(REQUEST, controller.signal);
    const queued = surface.ask(second);
    expect(surface.pending()?.key).toBe('k-1');

    controller.abort();

    await expect(first).resolves.toEqual({
      approved: false,
      reason: APPROVAL_CANCELLED_REASON,
    });
    expect(surface.pending()?.key).toBe('k-2');
    // The withdrawal settled NOTHING the user pressed: the next ask is still
    // answerable, and answering now settles IT.
    expect(surface.decide('a')).toBe(true);
    await expect(queued).resolves.toEqual({ approved: true, by: 'allow-once' });
  });

  it('withdraws a QUEUED ask without disturbing the shown one', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const shown = surface.ask(REQUEST);
    const controller = new AbortController();
    const queued = surface.ask(second, controller.signal);
    expect(surface.pending()?.key).toBe('k-1');

    controller.abort();

    await expect(queued).resolves.toMatchObject({ approved: false });
    expect(surface.pending()?.key).toBe('k-1');
    expect(surface.decide('d')).toBe(true);
    await expect(shown).resolves.toMatchObject({ approved: false });
  });

  it('never queues an ask whose signal is already aborted', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(surface.ask(REQUEST, controller.signal)).resolves.toEqual({
      approved: false,
      reason: APPROVAL_CANCELLED_REASON,
    });
    expect(surface.pending()).toBeUndefined();
  });

  it('a withdrawal after cancelPending is a no-op (the ask settled once)', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const controller = new AbortController();
    const pending = surface.ask(REQUEST, controller.signal);
    surface.cancelPending('quit');
    controller.abort();
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'quit',
    });
    expect(surface.pending()).toBeUndefined();
  });
});

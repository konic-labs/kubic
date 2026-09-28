// RED (issue #26): ApprovalView overlay + keybindings.
// §41 triggers/policy/explicit autoApprove/timeout→deny/memoOnce; §16.4
// centered 70%/60% overlay + focus/unfocus + nonCapturing; §16.6
// matchesKey/Focusable/CURSOR_MARKER/registry; §16.9 themes/keybindings.
// Headless snapshots render directly (no VirtualTerminal in Pi 0.85.1)
// like layout.test.ts. Faux-only: zero network, short real timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_MIN_WIDTH,
  type ApprovalOverlayHandle,
  type ApprovalOverlayOptions,
  ApprovalView,
  type ApprovalViewRequest,
  approvalKeyConflicts,
  approvalOverlayBounds,
  approvalOverlayOptions,
  createApprovalMemo,
  dismissApprovalOverlay,
  renderApprovalInline,
  renderApprovalLines,
  resolveApprovalAction,
  shouldUseInlineFallback,
  showApprovalOverlay,
  waitForApproval,
} from './approval-view.js';
import type { Component } from './tui-boundary.js';
import { CURSOR_MARKER } from './tui-boundary.js';

function request(): ApprovalViewRequest {
  return {
    key: 'k1',
    capability: 'destructive-shell',
    toolName: 'bash',
    command: 'rm -rf /tmp/x',
    paths: ['/tmp/x'],
    justification: 'clean scratch dir',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// Settles only once the clock reaches maxPendingMs — not a tick earlier.
async function settledAt(
  pending: Promise<unknown>,
  maxPendingMs: number,
): Promise<void> {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(maxPendingMs - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
}

describe('approval render (issue #26; §41)', () => {
  it('shows capability, justification, command+paths, and 3 actions', () => {
    const lines = renderApprovalLines(request(), 100);
    const doc = lines.join('\n');
    expect(doc).toContain('destructive-shell');
    expect(doc).toContain('clean scratch dir');
    expect(doc).toContain('rm -rf /tmp/x');
    expect(doc).toContain('/tmp/x');
    expect(doc).toContain('allow once');
    expect(doc).toContain('allow session');
    expect(doc).toContain('deny');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  it('renders the privilege-escalation capability name with no special cases (issue #131)', () => {
    // Pinned line-for-line: the dialog prints the capability string as-is,
    // so a new capability name renders with zero view changes.
    const lines = renderApprovalLines(
      {
        key: 'k-pe',
        capability: 'privilege-escalation',
        toolName: 'bash',
        command: 'sudo systemctl restart foo',
        summary: 'privilege-escalation: sudo systemctl restart foo',
      },
      100,
    );
    expect(lines).toEqual([
      'Approval required: privilege-escalation',
      'tool: bash',
      'summary: privilege-escalation: sudo systemctl restart foo',
      'command: sudo systemctl restart foo',
      'justification: (none)',
      '[a] allow once   [s] allow session   [d] deny',
    ]);
  });
});

describe('approval overlay geometry (issue #26; §16.4)', () => {
  it('is centered 70%/60% and capturing (focus)', () => {
    const options = approvalOverlayOptions();
    expect(options.width).toBe('70%');
    expect(options.maxHeight).toBe('60%');
    expect(options.anchor).toBe('center');
    expect(options.nonCapturing).not.toBe(true);
    expect(options.visible?.(100, 30)).toBe(true);
    expect(options.visible?.(70, 24)).toBe(false);
    expect(APPROVAL_MIN_WIDTH).toBe(80);
  });

  it('centers a 70-col box on 100x30', () => {
    expect(approvalOverlayBounds(100, 30)).toEqual({
      width: 70,
      height: 18,
      row: 6,
      col: 15,
    });
  });

  it('falls back inline below 80 columns', () => {
    expect(shouldUseInlineFallback(100)).toBe(false);
    expect(shouldUseInlineFallback(70)).toBe(true);
    const lines = renderApprovalInline(request(), 70);
    const doc = lines.join('\n');
    expect(doc).toContain('destructive-shell');
    expect(doc).toContain('deny');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(70);
  });
});

describe('approval keybindings (issue #26; §16.6/§16.9)', () => {
  it('resolves a/s/d via matchesKey with zero conflicts', () => {
    expect(resolveApprovalAction('a')).toBe('allow-once');
    expect(resolveApprovalAction('s')).toBe('allow-session');
    expect(resolveApprovalAction('d')).toBe('deny');
    expect(resolveApprovalAction('x')).toBeUndefined();
    expect(approvalKeyConflicts()).toEqual([]);
  });

  it('deny wins on a conflicting key', () => {
    expect(
      resolveApprovalAction('x', {
        'allow-once': ['x'],
        deny: ['x'],
      }),
    ).toBe('deny');
    expect(
      approvalKeyConflicts({
        'allow-once': ['x'],
        deny: ['x'],
      }),
    ).toEqual([{ key: 'x', actions: ['deny', 'allow-once'] }]);
  });

  it('lets user overrides win', () => {
    expect(resolveApprovalAction('x', { 'allow-once': ['x'] })).toBe(
      'allow-once',
    );
    expect(resolveApprovalAction('a', { 'allow-once': ['x'] })).toBeUndefined();
  });

  it('resolves keys plus refocuses the editor on decide', () => {
    const seen: string[] = [];
    let editorFocus = 0;
    const view = new ApprovalView({
      request: request(),
      onDecision: (action) => seen.push(action),
      onFocusEditor: () => editorFocus++,
    });
    view.handleInput('s');
    expect(seen).toEqual(['allow-session']);
    expect(editorFocus).toBe(1);
    view.handleInput('a');
    expect(seen).toEqual(['allow-session', 'allow-once']);
    expect(editorFocus).toBe(2);
    view.handleInput('x');
    expect(seen.length).toBe(2);
    expect(editorFocus).toBe(2);
  });
});

describe('approval focus (issue #26; §16.4/§16.6)', () => {
  // Fake Pi showOverlay semantics (pi-tui/dist/tui.js): focus only when
  // capturing AND visible — visible() gates on terminal size, so narrow
  // terminals never focus. hide() removes the entry; unfocus only moves
  // focus.
  function fakeTui(
    termWidth = 100,
    termHeight = 30,
  ): {
    shown: Component[];
    unfocused: Array<{ target: Component | null } | undefined>;
    hidden: number;
    handle: ApprovalOverlayHandle;
    tui: {
      showOverlay: (
        component: Component,
        options?: ApprovalOverlayOptions,
      ) => ApprovalOverlayHandle;
    };
  } {
    const unfocused: Array<{ target: Component | null } | undefined> = [];
    let hidden = 0;
    const handle: ApprovalOverlayHandle = {
      unfocus: (options) => {
        unfocused.push(options);
      },
      hide: () => {
        hidden++;
      },
    };
    const shown: Component[] = [];
    return {
      shown,
      unfocused,
      get hidden() {
        return hidden;
      },
      handle,
      tui: {
        showOverlay: (
          component: Component,
          options?: ApprovalOverlayOptions,
        ) => {
          shown.push(component);
          const visible = options?.visible?.(termWidth, termHeight) ?? true;
          if (!options?.nonCapturing && visible && 'focused' in component) {
            (component as { focused: boolean }).focused = true;
          }
          return handle;
        },
      },
    };
  }

  it('captures focus on show and removes the overlay on dismiss', () => {
    const fake = fakeTui();
    const editor: Component = { render: () => [], invalidate: () => {} };
    const view = new ApprovalView({ request: request() });
    expect(view.focused).toBe(false);
    const handle = showApprovalOverlay(fake.tui, view);
    expect(fake.shown).toEqual([view]);
    expect(view.focused).toBe(true);
    expect(view.render(100).join('\n')).toContain(CURSOR_MARKER);
    dismissApprovalOverlay(view, handle, editor);
    expect(view.focused).toBe(false);
    expect(fake.unfocused).toEqual([{ target: editor }]);
    expect(fake.hidden).toBe(1);
    expect(view.render(100).join('\n')).not.toContain(CURSOR_MARKER);
  });

  it('stays unfocused on narrow terminals where Pi never focuses', () => {
    const fake = fakeTui(70, 24);
    const editor: Component = { render: () => [], invalidate: () => {} };
    const view = new ApprovalView({ request: request() });
    const handle = showApprovalOverlay(fake.tui, view);
    expect(fake.shown).toEqual([view]);
    expect(view.focused).toBe(false);
    expect(view.render(70).join('\n')).not.toContain(CURSOR_MARKER);
    dismissApprovalOverlay(view, handle, editor);
    expect(fake.unfocused).toEqual([{ target: editor }]);
    expect(fake.hidden).toBe(1);
  });
});

describe('approval timeout + memoOnce (issue #26; §41)', () => {
  it('denies with reason on maxPendingMs expiry and never hangs headless', async () => {
    vi.useFakeTimers();
    const memo = createApprovalMemo();
    const pending = waitForApproval('k1', {
      memo,
      maxPendingMs: 20,
    });
    await settledAt(pending, 20);
    const verdict = await pending;
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
    expect(memo.decided('k1')).toEqual(verdict);
  });

  it('rejects invalid maxPendingMs instead of arming a bad timer', () => {
    for (const maxPendingMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        waitForApproval('k1', { memo: createApprovalMemo(), maxPendingMs }),
      ).toThrow(RangeError);
    }
  });

  it('resolves deny when awaitAnswer rejects instead of propagating', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', {
      memo,
      maxPendingMs: 50,
      awaitAnswer: () => Promise.reject(new Error('boom')),
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval await failed: boom',
    });
    expect(memo.decided('k1')).toEqual(verdict);
  });

  it('persists decisions: restart/rerender never re-asks; races settle once', async () => {
    const memo = createApprovalMemo();
    const first = memo.submit('k1', { approved: true, by: 'allow-once' });
    const raced = memo.submit('k1', {
      approved: false,
      reason: 'late deny',
    });
    expect(raced).toEqual(first);
    const again = await waitForApproval('k1', {
      memo,
      maxPendingMs: 20,
      awaitAnswer: () => {
        throw new Error('must not re-ask');
      },
    });
    expect(again).toEqual(first);
  });
});

describe('approval mutation hardening (issue #68)', () => {
  it('uses the inline fallback exactly below 80 columns', () => {
    expect(shouldUseInlineFallback(80)).toBe(false);
    expect(shouldUseInlineFallback(79)).toBe(true);
    expect(shouldUseInlineFallback(0)).toBe(true);
  });

  it('floors fractional overlay geometry instead of returning floats', () => {
    expect(approvalOverlayBounds(99, 29)).toEqual({
      width: 69,
      height: 17,
      row: 6,
      col: 15,
    });
  });

  it('omits empty command/paths and defaults justification for minimal requests', () => {
    const lines = renderApprovalLines(
      { key: 'k', capability: 'fs-read', toolName: 'read' },
      100,
    );
    const doc = lines.join('\n');
    expect(doc).toContain('Approval required: fs-read');
    expect(doc).toContain('tool: read');
    expect(doc).toContain('justification: (none)');
    expect(doc).not.toContain('command:');
    expect(doc).not.toContain('paths:');
    const emptyPaths = renderApprovalLines({ ...request(), paths: [] }, 100);
    expect(emptyPaths.join('\n')).not.toContain('paths:');
    const emptyCommand = renderApprovalLines(
      { ...request(), command: '' },
      100,
    );
    expect(emptyCommand.join('\n')).not.toContain('command:');
  });

  it('passes explicit overlay options through instead of forcing defaults', () => {
    const seen: ApprovalOverlayOptions[] = [];
    const view = new ApprovalView({ request: request() });
    const tui = {
      showOverlay: (
        _component: Component,
        options?: ApprovalOverlayOptions,
      ): ApprovalOverlayHandle => {
        seen.push(options ?? {});
        return { unfocus: () => {}, hide: () => {} };
      },
    };
    showApprovalOverlay(tui, view, { width: '50%' });
    expect(seen[0]?.width).toBe('50%');
  });

  it('dismisses unfocus-first so the editor target survives hide', () => {
    const order: string[] = [];
    const view = new ApprovalView({ request: request() });
    const editor: Component = { render: () => [], invalidate: () => {} };
    dismissApprovalOverlay(
      view,
      {
        unfocus: () => {
          order.push('unfocus');
        },
        hide: () => {
          order.push('hide');
        },
      },
      editor,
    );
    expect(order).toEqual(['unfocus', 'hide']);
  });

  it('resolves an approving answer through the memo', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', {
      memo,
      maxPendingMs: 50,
      awaitAnswer: () => Promise.resolve({ approved: true, by: 'allow-once' }),
    });
    expect(verdict).toEqual({ approved: true, by: 'allow-once' });
    expect(memo.decided('k1')).toEqual(verdict);
  });

  it('waits out an undefined answer to the timeout deny', async () => {
    vi.useFakeTimers();
    const memo = createApprovalMemo();
    const pending = waitForApproval('k1', {
      memo,
      maxPendingMs: 20,
      awaitAnswer: () => Promise.resolve(undefined),
    });
    await settledAt(pending, 20);
    const verdict = await pending;
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
  });

  it('denies immediately on maxPendingMs 0 without throwing', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', { memo, maxPendingMs: 0 });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 0ms',
    });
  });

  it('reports a non-Error rejection without an undefined reason', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', {
      memo,
      maxPendingMs: 50,
      awaitAnswer: () => Promise.reject('string boom'),
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval await failed: string boom',
    });
  });

  it('shows the overlay at exactly 80 columns, inline below', () => {
    const options = approvalOverlayOptions();
    expect(options.visible?.(80, 30)).toBe(true);
    expect(options.visible?.(79, 30)).toBe(false);
  });
});

// RED (issue #26): ApprovalView overlay + keybindings.
// §41 triggers/policy/explicit autoApprove/timeout→deny/memoOnce; §16.4
// centered 70%/60% overlay + focus/unfocus + nonCapturing; §16.6
// matchesKey/Focusable/CURSOR_MARKER/registry; §16.9 themes/keybindings.
// Headless snapshots render directly (no VirtualTerminal in Pi 0.85.1)
// like layout.test.ts. Faux-only: zero network, short real timers.
import { describe, expect, it } from 'vitest';
import type { Component } from './tui-boundary.js';
import { CURSOR_MARKER } from './tui-boundary.js';
import {
  APPROVAL_MIN_WIDTH,
  approvalKeyConflicts,
  approvalOverlayBounds,
  approvalOverlayOptions,
  ApprovalView,
  createApprovalMemo,
  renderApprovalInline,
  renderApprovalLines,
  resolveApprovalAction,
  shouldUseInlineFallback,
  showApprovalOverlay,
  dismissApprovalOverlay,
  waitForApproval,
  type ApprovalOverlayHandle,
  type ApprovalViewRequest,
} from './approval-view.js';

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
  function fakeTui(): {
    shown: Component[];
    unfocused: Array<{ target: Component | null } | undefined>;
    handle: ApprovalOverlayHandle;
    tui: {
      showOverlay: (
        component: Component,
      ) => ApprovalOverlayHandle;
    };
  } {
    const unfocused: Array<{ target: Component | null } | undefined> = [];
    const handle: ApprovalOverlayHandle = {
      unfocus: (options) => {
        unfocused.push(options);
      },
      hide: () => {},
    };
    const shown: Component[] = [];
    return {
      shown,
      unfocused,
      handle,
      tui: {
        showOverlay: (component: Component) => {
          shown.push(component);
          return handle;
        },
      },
    };
  }

  it('captures focus on show and exposes an explicit unfocus target', () => {
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
    expect(view.render(100).join('\n')).not.toContain(CURSOR_MARKER);
  });
});
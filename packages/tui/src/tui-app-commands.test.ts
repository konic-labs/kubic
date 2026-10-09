// Interactive TUI controller over the lane.
//
// Headless snapshots only (no VirtualTerminal in Pi 0.85.1): the root
// VStack renders pure, like renderLayout in layout.test.ts. Faux-only,
// zero network.

import type {
  KubicPresentationState,
  LaneSnapshot,
} from '@kubic/core/presentation';
import { describe, expect, it, vi } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import type {
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from './approval-view.js';
import { createKeyRegistry } from './keybindings.js';
import { createTuiApp } from './tui-app.js';

const SESSION = 'sess-1';

const MODEL = 'test-model';

// The app renders replicated state, so a test builds the state a
// projector would produce (the projector itself lives in host).
function presentation(
  over: Partial<LaneSnapshot> = {},
): KubicPresentationState {
  return {
    session: { sessionId: SESSION, approvalsSkipped: false },
    lane: {
      status: 'running',
      tools: [],
      queued: [],
      compacting: false,
      ...over,
    },
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

describe('model picker and thinking cycle', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });

  // The overlay seat the composition root attaches in prod: the picker is
  // shown through the same host the approval dialog uses.
  const pickerHost = () => {
    const shown: Array<{ render: (width: number) => string[] }> = [];
    let hidden = 0;
    return {
      shown,
      get hidden() {
        return hidden;
      },
      host: {
        showOverlay: (component: unknown) => {
          shown.push(component as { render: (width: number) => string[] });
          return {
            unfocus: () => {},
            hide: () => {
              hidden += 1;
            },
          };
        },
      } as unknown as ApprovalOverlayTui,
    };
  };

  it('classifies Alt+M and Alt+T for the loop', () => {
    const ui = app();
    expect(ui.handleInput('\u001bm')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
      pickModel: true,
    });
    expect(ui.handleInput('\u001bt')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
      cycleThinking: true,
    });
    // Kitty CSI-u encodings classify the same (parseKey, not raw bytes).
    expect(ui.handleInput('\u001b[109;3u')).toMatchObject({ pickModel: true });
    expect(ui.handleInput('\u001b[116;3u')).toMatchObject({
      cycleThinking: true,
    });
  });

  it('opens the picker overlay and reports the chosen row', () => {
    const ui = app();
    const seat = pickerHost();
    ui.attachApprovalOverlay(seat.host);
    const picked: string[] = [];
    expect(
      ui.openModelPicker({
        rows: [
          { provider: 'faux', id: 'big', label: 'faux/big', current: true },
          {
            provider: 'alt',
            id: 'm1',
            label: 'alt/m1',
            note: 'models.json',
          },
        ],
        onSelect: (row) => picked.push(`${row.provider}/${row.id}`),
      }),
    ).toBe(true);
    expect(ui.isModelPickerOpen()).toBe(true);
    const frame = seat.shown[0]?.render(80).join('\n') ?? '';
    // One group per provider, the live model marked, a
    // provider's origin in its header.
    expect(frame).toContain('┌─ Model');
    expect(frame).toContain('● big  current');
    expect(frame).toContain('ALT  ● models.json');
    expect(frame).toContain('m1');
    // The picker is modal: arrows move it and Enter selects the second row.
    ui.handleInput('\u001b[B');
    ui.handleInput('\r');
    expect(picked).toEqual(['alt/m1']);
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(seat.hidden).toBe(1);
    // Modal means the editor never saw those keys.
    expect(ui.editor.getText()).toBe('');
  });

  it('cancels the picker with Esc and leaves the model alone', () => {
    const ui = app();
    const seat = pickerHost();
    ui.attachApprovalOverlay(seat.host);
    let cancelled = 0;
    ui.openModelPicker({
      rows: [{ provider: 'faux', id: 'big', label: 'faux/big', current: true }],
      onSelect: () => {},
      onCancel: () => {
        cancelled += 1;
      },
    });
    expect(ui.handleInput('\u001b')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(cancelled).toBe(1);
    expect(seat.hidden).toBe(1);
  });

  it('refuses the picker on a terminal below the overlay minimum', () => {
    const ui = app();
    const shown: unknown[] = [];
    // A 50-column host: Pi's own visible() gate would refuse to composite
    // the overlay, so the picker must not become an invisible modal.
    ui.attachApprovalOverlay({
      showOverlay: (component: unknown) => {
        shown.push(component);
        return { unfocus: () => {}, hide: () => {} };
      },
      terminal: { columns: 50, rows: 30 },
    } as unknown as ApprovalOverlayTui);
    expect(
      ui.openModelPicker({
        rows: [{ provider: 'faux', id: 'big', label: 'faux/big' }],
        onSelect: () => {},
      }),
    ).toBe(false);
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(shown).toEqual([]);
    // Input still reaches the editor: the refused picker is not modal.
    for (const ch of 'hi') ui.handleInput(ch);
    expect(ui.editor.getText()).toBe('hi');
  });

  it('closes the picker when the terminal shrinks below the minimum', () => {
    const ui = app();
    let columns = 120;
    const seat = {
      showOverlay: () => ({ unfocus: () => {}, hide: () => {} }),
      terminal: {
        get columns() {
          return columns;
        },
        rows: 30,
      },
    } as unknown as ApprovalOverlayTui;
    ui.attachApprovalOverlay(seat);
    let cancelled = 0;
    expect(
      ui.openPicker({
        rows: [{ value: '/help', label: '/help' }],
        onSelect: () => {},
        onCancel: () => {
          cancelled += 1;
        },
      }),
    ).toBe(true);
    expect(ui.isModelPickerOpen()).toBe(true);
    // The overlay cannot be composited: the next key closes the
    // picker (a cancel) and goes to the editor instead of vanishing.
    columns = 50;
    ui.handleInput('x');
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(cancelled).toBe(1);
    expect(ui.editor.getText()).toBe('x');
  });

  it('refuses to open the picker without an overlay seat', () => {
    const ui = app();
    expect(
      ui.openModelPicker({
        rows: [{ provider: 'faux', id: 'big', label: 'faux/big' }],
        onSelect: () => {},
      }),
    ).toBe(false);
    expect(ui.isModelPickerOpen()).toBe(false);
  });
});

describe('slash commands in the app', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
  // Pi's editor resolves the autocomplete provider asynchronously; two turns
  // of the microtask queue are enough for the suggestions to be rendered.
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('lists the registry commands as soon as a slash is typed', async () => {
    const ui = app();
    ui.handleInput('/');
    await settle();
    const frame = ui.render(100).join('\n');
    // The popup shows the first rows of the registry (Pi caps the list).
    expect(frame).toContain('/help');
    expect(frame).toContain('/session');
    expect(frame).toContain('/new');
    // The draft is still the operator's text.
    expect(ui.editor.getText()).toBe('/');
  });

  it('renders a command notice in the transcript, and a lane snapshot clears it', () => {
    const ui = app();
    ui.appendNotice(['/help — the commands', '/session — id, tokens, cost']);
    const doc = ui.render(100).join('\n');
    expect(doc).toContain('/help — the commands');
    expect(doc).toContain('/session — id, tokens, cost');
    // A lane snapshot is the session's own transcript: the notice goes, and
    // the NEXT notice starts from an empty list (a stale list
    // must not be re-applied under the new report).
    ui.applyLaneEntries([]);
    expect(ui.render(100).join('\n')).not.toContain('/help — the commands');
    ui.appendNotice(['/session — the second one']);
    const after = ui.render(100).join('\n');
    expect(after).toContain('/session — the second one');
    expect(after).not.toContain('/help — the commands');
    expect(after).not.toContain('/session — id, tokens, cost');
  });

  it('reports the session id, tokens and cost from the status rows', () => {
    const ui = app();
    ui.setUsage([
      {
        model: MODEL,
        provider: 'faux',
        usage: {
          input: 1200,
          output: 340,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 1550,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.25,
          },
        },
      },
    ]);
    const report = ui.sessionReport('/work/repo');
    expect(report).toContain(`session ${SESSION}`);
    expect(report).toContain('in /work/repo');
    expect(report).toContain(MODEL);
    expect(report).toContain('in 1200 out 340');
    expect(report).toContain('$0.25');
    // Without a known workspace the report simply omits it.
    expect(ui.sessionReport()).not.toContain('in /work/repo');
  });

  it('resets every session-scoped surface for /new and /resume', () => {
    const ui = app();
    ui.setUsage([
      {
        model: MODEL,
        provider: 'faux',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
      },
    ]);
    ui.appendNotice(['old turn']);
    ui.applyPresentation(
      presentation({
        tools: [
          {
            toolCallId: 't1',
            toolName: 'read',
            status: 'running',
            isError: false,
          },
        ],
      }),
    );
    ui.setPendingEcho('old echo');
    ui.applyPresentation(presentation({ queued: ['old queue'] }));
    expect(ui.render(100).join('\n')).toContain('old turn');

    ui.resetSession({ sessionId: 'sess-2', model: 'alt/m2', thinking: 'high' });

    const doc = ui.render(100).join('\n');
    expect(doc).not.toContain('old turn');
    expect(doc).not.toContain('old echo');
    expect(doc).not.toContain('old queue');
    expect(doc).not.toContain('● read');
    expect(doc).toContain('alt/m2');
    expect(doc).toContain('sess-2');
    // The usage rows are the new session's (none here), not the old totals.
    expect(ui.sessionReport()).toContain('in 0 out 0');
    expect(ui.sessionReport()).toContain('session sess-2');
  });

  it('opens the generic picker for the palette and the session list', () => {
    const ui = app();
    const shown: Array<{ render: (width: number) => string[] }> = [];
    ui.attachApprovalOverlay({
      showOverlay: (component: unknown) => {
        shown.push(component as { render: (width: number) => string[] });
        return { unfocus: () => {}, hide: () => {} };
      },
    } as unknown as ApprovalOverlayTui);
    const picked: string[] = [];
    expect(
      ui.openPicker({
        rows: [
          { value: '/help', label: '/help', description: 'list the commands' },
          { value: '/quit', label: '/quit', description: 'leave the TUI' },
        ],
        onSelect: (value) => picked.push(value),
      }),
    ).toBe(true);
    const frame = shown[0]?.render(80).join('\n') ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('list the commands');
    ui.handleInput('\r');
    expect(picked).toEqual(['/help']);
    expect(ui.isModelPickerOpen()).toBe(false);
  });
});

describe('app-level wiring that no test executed', () => {
  const REQUEST: ApprovalViewRequest = {
    key: 'k-tui-app',
    capability: 'destructive-shell',
    toolName: 'bash',
    command: 'rm -rf build',
  };

  function seat(): {
    host: ApprovalOverlayTui;
    shown: unknown[];
    renders: number;
  } {
    const state = { shown: [] as unknown[], renders: 0 };
    const host = {
      showOverlay: (component: unknown) => {
        state.shown.push(component);
        return { unfocus: () => {}, hide: () => {} };
      },
      requestRender: () => {
        state.renders += 1;
      },
      terminal: { columns: 120, rows: 30 },
    } as unknown as ApprovalOverlayTui;
    return Object.assign(state, { host });
  }

  it('repaints the live screen when an ask arrives after the overlay is attached', async () => {
    // armingMs 0: this test is about the repaint, not the arming delay.
    const surface = createApprovalSurface({ armingMs: 0 });
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const seatState = seat();
    ui.attachApprovalOverlay(seatState.host);
    expect(ui.hasPendingApproval()).toBe(false);
    const before = seatState.renders;
    const pending = ui.requestApproval(REQUEST);
    // The ask itself asks for a frame: an async lane turn must not wait for
    // the next keypress to show its card (in the editor slot,
    // no overlay).
    expect(seatState.renders).toBeGreaterThan(before);
    expect(seatState.shown).toHaveLength(0);
    expect(ui.render(120).join('\n')).toContain('[APPROVAL] ━ bash');
    expect(ui.hasPendingApproval()).toBe(true);
    surface.decide('d');
    await pending;
  });

  it('shows an ask that arrived before the overlay was attached', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    // The lane asked while the app had no seat (the boot order of `kubic tui`).
    const pending = ui.requestApproval(REQUEST);
    const seatState = seat();
    ui.attachApprovalOverlay(seatState.host);
    // Attaching repaints: the card of the pending request is on screen.
    expect(seatState.renders).toBeGreaterThan(0);
    expect(ui.render(120).join('\n')).toContain('$ rm -rf build');
    expect(ui.hasPendingApproval()).toBe(true);
    surface.decide('d');
    await pending;
  });

  it('clears the echoed prompt when a busy turn ends with no lane commit', () => {
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    ui.onSubmit(() => 'accepted');
    ui.setBusy(true);
    for (const ch of 'zzz echo me') ui.handleInput(ch);
    ui.handleInput('\r');
    // The prompt is echoed while the lane works.
    expect(ui.render(100).join('\n')).toContain('▌ zzz echo me');
    // The turn ends without committing the entry (an abort, or a settle with
    // no commit): the echo must not outlive the turn it belongs to.
    ui.setBusy(false);
    const doc = ui.render(100).join('\n');
    expect(doc).not.toContain('▌ zzz echo me');
    expect(doc).not.toContain('zzz echo me');
  });

  it('has no uncalled setNotice on the app surface', () => {
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    expect('setNotice' in ui).toBe(false);
  });
});

// The app dispatches through the keybinding
// registry, so an override rebinds the action everywhere — the dispatch,
// the global-key claim ahead of the editor and the hints.
describe('keybinding overrides in the app', () => {
  const rebound = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
      keys: createKeyRegistry({
        'panel.diff': ['ctrl+g'],
      }),
    });

  it('ctrl+g toggles the diff panel and ctrl+o reaches the editor', () => {
    const ui = rebound();
    ui.handleInput('\x07');
    expect(ui.panelMode()).toBe('diff');
    ui.handleInput('\x07');
    expect(ui.panelMode()).toBe('closed');
    const toEditor = vi.spyOn(ui.editor, 'handleInput');
    ui.handleInput('\x0f');
    expect(toEditor).toHaveBeenCalledWith('\x0f');
    expect(ui.panelMode()).toBe('closed');
  });

  it('the key hints name the rebound key', () => {
    const frame = rebound().render(160).join('\n');
    expect(frame).toContain('^G diff');
    expect(frame).not.toContain('^O diff');
  });
});

// A retry backoff or a compaction can take tens
// of seconds; the footer names it instead of looking like a hang, and clears
// it the moment the state does.
describe('lane activity on the footer', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
  const footer = (ui: ReturnType<typeof app>): string =>
    ui.render(100).find((line) => line.includes('⟳')) ?? '';

  it('shows the retry attempt and its error, then clears it', () => {
    const ui = app();
    ui.applyPresentation(
      presentation({ retrying: { attempt: 2, error: 'server overloaded' } }),
    );
    expect(footer(ui)).toContain('⟳ retrying · attempt 2 — server overloaded');
    ui.applyPresentation(presentation());
    expect(footer(ui)).toBe('');
    expect(ui.render(100).join('\n')).toContain('⏎ send');
  });

  it('renders the compaction indicator (headless snapshot)', () => {
    const ui = app();
    ui.applyPresentation(presentation({ compacting: true }));
    expect(footer(ui).trimEnd()).toMatchInlineSnapshot(
      `" ⟳ compacting context…"`,
    );
  });
});

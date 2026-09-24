// Interactive TUI controller over the solo lane (issue #75; §16).
// Presentation only: the controller replicates the core
// KubicPresentationState (§66 — contracts only, no authority) into the
// tested views (tree #24, transcript #23, status #27) arranged by the
// layout root (#22). Keyboard routing mirrors the tree's own toggle keys
// (T/t per #24); Ctrl-C quits. The composition root (apps/kubic) owns
// the lane boot, the alt-screen lifecycle, and shutdown.

import type { KubicPresentationState } from '../../core/src/presentation.js';
import { buildLayoutRoot, type Viewport } from './layout.js';
import {
  StatusBar,
  type StatusBarState,
  type StatusUsageRow,
} from './status-bar.js';
import { createTranscriptView, type TranscriptView } from './transcript.js';
import { AgentTreeView, type LaneEventLike, TOGGLE_KEYS } from './tree.js';
import { Text, type VStack } from './tui-boundary.js';

export type { LaneEventLike, Viewport };

export interface TuiAppSeed {
  readonly sessionId: string;
  readonly model: string;
  readonly thinking?: string;
  readonly label?: string;
}

// §66 replication: the TUI holds no authority — it reads the replicated
// snapshot only. The model id is runtime (not presentation state), so it
// arrives alongside.
export function seedFromPresentation(
  state: KubicPresentationState,
  model: string,
): TuiAppSeed {
  return { sessionId: state.session.sessionId, model };
}

export interface TuiInputResult {
  readonly quit: boolean;
  readonly consumed: boolean;
}

export const TUI_QUIT_KEY = '\x03';

export interface TuiApp {
  readonly root: VStack;
  readonly tree: AgentTreeView;
  readonly transcript: TranscriptView;
  readonly status: StatusBar;
  render(width: number): string[];
  handleInput(data: string): TuiInputResult;
  finalDocument(width: number): string[];
  applyLaneEvent(event: LaneEventLike): void;
  setUsage(rows: ReadonlyArray<StatusUsageRow>): void;
}

export function createTuiApp(seed: TuiAppSeed): TuiApp {
  const tree = new AgentTreeView(undefined, { label: seed.label ?? 'solo' });
  const transcript = createTranscriptView();
  transcript.appendDelta({
    id: 'session',
    kind: 'text',
    append: `session ${seed.sessionId} · model ${seed.model}`,
  });
  const barState: StatusBarState = {
    model: seed.model,
    thinking: seed.thinking ?? 'off',
    rows: [],
    mode: 'solo',
    approvalsSkipped: false,
    sessionId: seed.sessionId,
  };
  const status = new StatusBar(barState);
  const editor = new Text('');
  const root = buildLayoutRoot({
    tree,
    transcript: transcript.component,
    status,
    editor,
  });
  return {
    root,
    tree,
    transcript,
    status,
    render: (width: number): string[] => root.render(width),
    handleInput: (data: string): TuiInputResult => {
      if (data === TUI_QUIT_KEY) return { quit: true, consumed: true };
      if (TOGGLE_KEYS.has(data)) {
        tree.handleInput(data);
        return { quit: false, consumed: true };
      }
      return { quit: false, consumed: false };
    },
    finalDocument: (width: number): string[] => root.render(width),
    applyLaneEvent: (event: LaneEventLike): void => {
      tree.update(event);
    },
    setUsage: (rows: ReadonlyArray<StatusUsageRow>): void => {
      status.setRows(rows);
    },
  };
}

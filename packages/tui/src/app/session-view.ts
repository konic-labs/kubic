// The session the app shows: its id and title, the live model, the
// workspace facts the header reads, and the first screen's preflight.
import { keyCap } from '../chrome.js';
import { sanitizeLaneText } from '../lane-text.js';
import { type PreflightInfo, renderPreflight } from '../preflight.js';
import { tuiTheme } from '../theme.js';
import type { AppCore } from './core.js';
import type { TuiRecentSession, TuiWorkspace } from './types.js';

export class SessionView {
  private readonly core: AppCore;
  // The live model label (seed = the boot's model, replaced by
  // `/model`). The header, welcome block and status bar all read it, so one
  // call keeps the three surfaces from drifting apart.
  modelLabel: string;
  thinkingLabel: string;
  // `/new` and `/resume` keep the app but change the session it
  // shows, so the id every lane apply, report cell and the welcome block are
  // keyed by is state.
  sessionId: string;
  // The header's session title — the first committed prompt
  // (fresh or resumed alike), else the short id; cleared with the session.
  title: string | undefined;
  workspace: TuiWorkspace | undefined;
  // The first screen is the preflight, drawn from
  // live state each frame — the model, the workspace the header reads, the
  // keys and the recent sessions — and gone after the first prompt (a
  // resumed session with history never shows it). The honest isolation
  // sentence is the composition root's; `/safety` prints the limits in full.
  private welcomeVisible = true;
  private recentSessions: readonly TuiRecentSession[] = [];

  constructor(core: AppCore) {
    this.core = core;
    this.modelLabel = core.seed.model;
    this.thinkingLabel = core.seed.thinking ?? 'off';
    this.sessionId = core.seed.sessionId;
    this.workspace = cleanWorkspace(core.seed.workspace);
    this.refreshWelcome();
  }

  // The live model label the header, welcome block and status bar show; one
  // path for the boot, a `/model` switch and a session reset.
  applyModel(next: string, thinking?: string): void {
    this.modelLabel = sanitizeLaneText(next);
    if (thinking !== undefined) this.thinkingLabel = thinking;
    const { status } = this.core;
    status.setState({
      ...status.getState(),
      model: this.modelLabel,
      thinking: this.thinkingLabel,
    });
    this.refreshWelcome();
  }

  setWorkspace(next: TuiWorkspace): void {
    this.workspace = cleanWorkspace(next);
  }

  setRecentSessions(sessions: readonly TuiRecentSession[]): void {
    this.recentSessions = sessions.map((session) => ({
      title: sanitizeLaneText(session.title),
      age: sanitizeLaneText(session.age),
      detail: sanitizeLaneText(session.detail),
    }));
    this.core.requestRender();
  }

  hideWelcome(): void {
    if (!this.welcomeVisible) return;
    this.welcomeVisible = false;
    this.refreshWelcome();
  }

  // A fresh session starts on the first screen again (a
  // resumed one with history hides it when its entries apply).
  showWelcome(): void {
    this.welcomeVisible = true;
    this.refreshWelcome();
  }

  private refreshWelcome(): void {
    this.core.transcript.setWelcome(
      this.welcomeVisible
        ? (width: number) =>
            renderPreflight(tuiTheme().ui, this.preflightInfo(), width)
        : [],
    );
  }

  private preflightInfo(): PreflightInfo {
    const { seed, keys } = this.core;
    const modelLabel = this.modelLabel;
    const workspace = this.workspace;
    const provider = modelLabel.split('/')[0] ?? modelLabel;
    const keySource = seed.preflight?.keySource?.(provider);
    const known = workspace !== undefined;
    return {
      version: seed.preflight?.version ?? '',
      provider: {
        model: modelLabel,
        ...(modelLabel === seed.preflight?.testingModel
          ? { testing: true }
          : {}),
        ...(keySource === undefined
          ? {}
          : { keySource: sanitizeLaneText(keySource) }),
      },
      ...(seed.cwdLabel === undefined
        ? {}
        : {
            project: {
              path: seed.cwdLabel,
              ...(workspace?.branch === undefined
                ? known
                  ? { git: false }
                  : {}
                : { branch: workspace.branch, git: true }),
              ...(workspace?.dirty === undefined
                ? {}
                : { dirty: workspace.dirty }),
            },
          }),
      ...(seed.preflight?.trust === undefined
        ? {}
        : { trust: seed.preflight.trust }),
      isolation: seed.preflight?.isolation?.() ?? seed.laneNotice?.() ?? '',
      keys: {
        palette: keyCap(keys.label('app.palette')),
        help: keyCap(keys.label('help.keys')),
      },
      recent: this.recentSessions,
    };
  }
}

// Sanitized at ingress like lane text: a directory name is local data, but
// it is still printed into the operator's terminal.
function cleanWorkspace(
  next: TuiWorkspace | undefined,
): TuiWorkspace | undefined {
  return next === undefined
    ? undefined
    : {
        project: sanitizeLaneText(next.project),
        ...(next.branch === undefined
          ? {}
          : { branch: sanitizeLaneText(next.branch) }),
        ...(next.dirty === undefined ? {} : { dirty: next.dirty }),
      };
}

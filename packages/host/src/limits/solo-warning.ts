// Solo no-isolation startup warning (issue #58; §59.1i-ii, §3.7).
// Solo announces its trust model on every fresh start: in-process, the
// user's own authority over files/network/credentials, no isolation, no
// containment, no prompt-injection prevention. Controls are approvals
// (ask-user by default) plus the change journal (review `kubic diff`,
// revert `kubic undo`). Pure strings — the module owns the text and the
// emission decision so both surfaces read and behave identically; the
// sinks themselves live at the composition root (issue #89):
// apps/kubic/src/headless-run.ts writes the block to stderr before the
// first turn, apps/kubic/src/tui-run.ts carries the one-line statement as
// the editor footer from the first render.
export function soloTuiLine(): string {
  return 'solo: no isolation - in-process with your authority (files, network, credentials); controls: approvals + journal';
}

export function soloWarningLines(): string[] {
  return [
    'warning: solo mode has no isolation: this run executes in-process with your user authority.',
    'warning: authority covers your files, network, and credentials - there is no containment and no prompt-injection prevention.',
    'warning: controls are approvals (ask-user by default) + the change journal: review with `kubic diff`, revert with `kubic undo` (honest limits §59.1, §3.7).',
  ];
}

export function formatSoloWarningStderr(): string {
  return soloWarningLines().join('\n');
}

export function emitSoloWarning(out: (line: string) => void): void {
  for (const line of soloWarningLines()) out(line);
}

export type SoloNoticeEnv = Record<string, string | undefined>;

// The two environment inputs, named so the docs page can be pinned against
// them (the drift gate in solo-notice-prod.test.ts fails if the page stops
// naming either one, or names a different spelling).
export const SOLO_NOTICE_WORKER_ENV = 'KUBIC_WORKER_ID';
export const SOLO_NOTICE_OPT_OUT_ENV = 'KUBIC_NO_NOTICE';

// The emission decision (issue #89), shared by `run` and `tui` so the two
// surfaces cannot disagree. Two inputs, no session state:
//   - an orchestrator-managed child carries KUBIC_WORKER_ID in its
//     environment (§3.8, issue #94), and that mode's own worktree limit is
//     reported by `kubic doctor` instead — so the child announces nothing;
//   - KUBIC_NO_NOTICE=1 is the documented operator opt-out.
// A `--session` resume still announces: the rule is per process start, not
// per session. An empty KUBIC_WORKER_ID is not an identity (the readiness
// marker reads the same way, headless-run.ts) and neither is `=0` for the
// opt-out, so both stay on the announcing side.
export function shouldEmitSoloNotice(env: SoloNoticeEnv): boolean {
  const workerId = env[SOLO_NOTICE_WORKER_ENV];
  if (workerId !== undefined && workerId !== '') return false;
  const optOut = env[SOLO_NOTICE_OPT_OUT_ENV];
  return optOut !== '1' && optOut !== 'true';
}

// The no-isolation startup warning.
// Kubic announces its trust model on every fresh start: in-process, the
// user's own authority over files/network/credentials, no isolation, no
// containment, no prompt-injection prevention. Controls are approvals
// (ask-user by default) plus the change journal (review `kubic diff`,
// revert `kubic undo`). Pure strings — the module owns the text and the
// emission decision so both surfaces read and behave identically; the
// sinks themselves live at the composition root:
// apps/kubic/src/headless-run.ts writes the block to stderr before the
// first turn; apps/kubic/src/tui-run.ts shows the one-line statement in the
// welcome block from the first render and the full block on `/safety`.
export function noIsolationTuiLine(): string {
  return 'Kubic runs in-process with your authority: no isolation (files, network, credentials); controls: approvals + journal';
}

export function noIsolationNoticeLines(): string[] {
  return [
    'warning: Kubic runs in-process with your authority: no isolation.',
    'warning: authority covers your files, network, and credentials - there is no containment and no prompt-injection prevention.',
    'warning: controls are approvals (ask-user by default) + the change journal: review with `kubic diff`, revert with `kubic undo` (honest limits).',
  ];
}

export function emitNoIsolationNotice(out: (line: string) => void): void {
  for (const line of noIsolationNoticeLines()) out(line);
}

export type NoticeEnv = Record<string, string | undefined>;

// The opt-out's environment variable.
export const NOTICE_OPT_OUT_ENV = 'KUBIC_NO_NOTICE';

// The emission decision, shared by `run` and `tui` so the two
// surfaces cannot disagree: KUBIC_NO_NOTICE=1 is the documented operator
// opt-out. A `--session` resume still announces: the rule is per process
// start, not per session. `=0` is not an opt-out.
export function shouldEmitNotice(env: NoticeEnv): boolean {
  const optOut = env[NOTICE_OPT_OUT_ENV];
  return optOut !== '1' && optOut !== 'true';
}

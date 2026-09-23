// Solo no-isolation startup warning (issue #58; §59.1i-ii, §3.7).
// Solo announces its trust model on every fresh start: in-process, the
// user's own authority over files/network/credentials, no isolation, no
// containment, no prompt-injection prevention. Controls are approvals
// (ask-user by default) plus the change journal (review `kubic diff`,
// revert `kubic undo`). Pure strings — the TUI status seam and the run
// stderr sink are wired by other issues; this module only owns the text
// so both surfaces read identically.
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

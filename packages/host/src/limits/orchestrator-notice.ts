// Orchestrator worktree messaging (issue #58; §59.1).
// Worktrees separate concurrent writers only: one worker process plus
// one git worktree per subagent. That is scheduling hygiene, not
// isolation and not containment — orchestrator messaging must never
// imply otherwise. Pure strings; spawn-site wiring is other issues.
export function buildOrchestratorWorktreeNotice(): string[] {
  return [
    'orchestrator worktrees separate concurrent writers only: one worker process plus one git worktree per subagent.',
    'worktrees are not isolation and not containment: workers share your user authority and read the same model output.',
    'the model is never trusted (§59): approvals + journal stay the controls in orchestrator mode too.',
  ];
}

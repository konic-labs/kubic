# Orchestrator mode

> Design ref: §5.2, §9.2, §44, §41.1, §59.1 honest limits. Owner:
> issue [#62](https://github.com/konic-labs/kubic/issues/62).

Orchestrator is Kubic's opt-in delegation mode. The agent stops
executing and becomes a manager: it fans work out to subagents, each
of which gets its own worker process and its own git worktree, then
merges what they produce. The mode is session-scoped and requires a
git repository — outside one, the request is refused and the run
continues in [solo](solo.md).

## How delegation works

- The manager holds a small allowlist of delegation and
  workspace-merge tools only. Direct execution (shell, file reads and
  writes, search) is forbidden to the manager structurally, not by
  flag — it can direct work, never do it.
- Each subagent runs as a worker in its own process, confined to its
  own worktree. Writes landing outside the agent's worktree raise an
  approval instead of proceeding silently (§44, §41.1).
- Results flow back through collection and merge: the manager reviews,
  attributes, and settles worker output into the main tree,
  with conflicts surfaced rather than auto-resolved.

## Worktrees are scheduling, not isolation

Worktrees separate concurrent writers only. That is scheduling hygiene
— parallel agents not clobbering each other's files — not isolation
and not containment: workers share the user's authority and read the
same untrusted model output. Orchestrator messaging must never imply
otherwise (§59.1). The model is never trusted in either mode, so
approvals plus the change journal stay the controls here too; see
[change journal and safety](journal-and-safety.md).

## When to reach for it

One agent plus a worktree each is the shape for parallelisable work
across distinct areas of a repo. For everything else — and always by
default — there is [solo](solo.md): one agent, in-process, no
delegation overhead.

Implementation detail lives on the [host package page](../packages/host.md)
and the [worker package page](../packages/worker.md); command
behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also [solo](solo.md) and
[journal and safety](journal-and-safety.md).

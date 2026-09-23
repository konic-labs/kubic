# Solo mode

> Design ref: §5.1, §20.7, §59.1 honest limits, §3.7. Owner: issue
> [#62](https://github.com/konic-labs/kubic/issues/62).

Solo is Kubic's default and its architecture: one agent working
directly in the user's directory. One Pi session plus one agent lane
run in-process — harness, lane, and tools in a single process with
zero IPC on the path. There is no delegation in solo mode and no
second trust zone.

## No isolation — stated plainly

**Solo mode has no isolation.** The run executes in-process with the
user's own authority over files, network, and credentials. There is no
containment and no prompt-injection prevention: model output is never
trusted, and anything the agent can reach, a mistaken or manipulated
instruction can reach too. Solo is a single trust zone, and these docs
never imply otherwise (§59.1).

This is announced, not buried: every fresh start prints the solo
no-isolation warning, and the TUI carries the same one-line trust
statement, so both surfaces read identically.

## The controls that exist instead

With no boundary to lean on, solo relies on two controls:

- **Approvals** — dangerous operations ask the user first
  (ask-user by default) and deny on timeout. See
  [change journal and safety](journal-and-safety.md).
- **Change journal** — every edit is recorded, reviewable with
  `kubic diff`, and reversible with `kubic undo`, including after the
  terminal closes. See
  [change journal and safety](journal-and-safety.md).

## When solo is not the mode

Delegation needs [orchestrator](orchestrator.md): an opt-in,
session-scoped mode where a manager fans work out to one worker
process plus one git worktree per subagent. Orchestrator requires a
git repository and falls back to solo without one. The trust story
does not change there — approvals and the journal stay the controls.

Implementation detail lives on the [worker package page](../packages/worker.md);
command behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also
[orchestrator](orchestrator.md) and
[journal and safety](journal-and-safety.md).

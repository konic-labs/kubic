# Change journal and safety

> Design ref: §42 journal, §41 approvals safety model, §59.1 honest
> limits. Owner: issue
> [#62](https://github.com/konic-labs/kubic/issues/62).

Kubic's safety model has two halves: a VCS-independent change journal
that makes every edit reviewable and reversible, and an approvals
model where the user — never the manager, never the model — decides
what dangerous operations may proceed. Both hold identically in
[solo](solo.md) and [orchestrator](orchestrator.md) modes.

## Change journal (§42)

The journal records every file edit the agent makes, whether or not
the directory is a git repository — `kubic diff` and `kubic undo`
work anywhere. Entries are append-only and persist across sessions,
so undo works after the terminal closes. Review the record, revert a
step or a path, check status and history; entries the journal cannot
reconstruct (recorded hash, no retrievable pre-image) are reported as
non-reversible rather than guessed at. Retention bounds keep growth
finite: a size cap is enforced on every append, with opt-in age
pruning.

## Approvals (§41)

Dangerous capabilities — network, credentials, destructive shell,
installs, deploys, pushes, writes outside the workspace, agent
spawning, budget overruns — route to the user first (ask-user by
default) or to deny. The rules are fail-closed:

- The decider is the user. There is no manager-approval path and no
  model self-approval, structurally, not by flag.
- Every ask is time-bounded and denies on timeout; headless runs can
  never hang on an open question.
- The first answer wins; only settled decisions persist, never open
  questions — after a restart, pending asks time out to deny.
- Decisions are session-scoped unless the host explicitly wires a
  shared store.

## What the model does and does not promise (§59.1)

It promises: every edit recorded and reversible by default, every
dangerous operation gated on an explicit user decision, every timeout
and restart failing closed to deny.

It does not promise: isolation (solo runs in-process with the user's
own authority), containment (worktrees separate concurrent writers
only), prompt-injection prevention (model output is never trusted), or
airtight confinement (the worktree check is lexical and must be
re-checked at use time). Approvals plus the journal are the controls;
everything else would be someone else's guarantee.

Journal mechanics live on the [exec package page](../packages/exec.md),
approval wiring on the [host package page](../packages/host.md), and
command behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also [solo](solo.md) and
[orchestrator](orchestrator.md).

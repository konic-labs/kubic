# Orchestrator mode

> Design ref: §5.2, §9.2, §44, §41.1, §45, §59.1 honest limits. Owner:
> issue [#95](https://github.com/konic-labs/kubic/issues/95).
> **Delegation model as shipped (issue #95, 2026-09-25):** the CLI process
> is the manager. This page describes that model; the manager *agent* lane
> the design describes (§9.2) is not wired, and the issues that own it are
> named below.

Orchestrator is Kubic's opt-in delegation mode: `kubic orchestrate` spawns
one worker process and one git worktree per subagent and merges what they
produce. The mode is session-scoped, requires a git repository — outside
one the request is refused and nothing runs (there is no silent fallback to
solo) — and `run` never delegates.

## How delegation actually works

- **The CLI plans, the CLI merges.** The `kubic orchestrate` process reads
  `--agents`, creates one worktree per agent, spawns one child `kubic run`
  per agent, and settles them through the merge queue. There is no planning
  agent in the loop: the "plan" is the agent list on the command line.
- **Every worker runs the same prompt.** `-p` is handed to each child
  verbatim. Worker prompts may not differ today; per-worker prompts derived
  from a plan are issue [#103](https://github.com/konic-labs/kubic/issues/103).
- **The CLI commits for the worker; the worker never commits.** A worker child
  is `kubic run`, which does not run `git commit`. After a worker exits 0 the
  orchestrator stages whatever it left on its branch (`git add -A`) and commits
  it under `kubic-worker` provenance, then merges. The invariant that holds is
  about *authorship of the change content*, not about who types `git commit`:
  the manager lane never authors what goes into a worker's change — it does not
  write, edit or apply files, and `assertManagerZeroWrites` proves the recorded
  merge-path trace stays write-free. Merges are the only write the orchestrator
  performs on the main tree.
- **Merge approvals go to you.** Interactive runs prompt per merge; `--yes`
  auto-approves; a headless run with no decider denies closed (exit 4).
  The *worker* approval layer — requests routed to the user with opt-in
  budgets (§41) — is issue
  [#105](https://github.com/konic-labs/kubic/issues/105).
- **Roles are not on this path.** `.kubic/roles/*.md` exist and the resolver
  parses them, but no worker is assigned a role and no role prompt is
  composed; role-driven prompts are issue
  [#104](https://github.com/konic-labs/kubic/issues/104).
- **Conflict delegation, parallel surfacing and retained-worktree status**
  are implemented and unreachable; they are issue
  [#106](https://github.com/konic-labs/kubic/issues/106).

The manager toolset the design fixes in §40 (`spawn_agent`, `wait_for_agent`,
`workspace_merge`, …) is implemented as host contracts
(`packages/host/src/orchestrator/manager.ts`) and checked by tests, but no
live lane registers it — that wiring is issue
[#103](https://github.com/konic-labs/kubic/issues/103) too. Until then the
manager's tool allowlist is not what constrains delegation; the CLI's own
argv is.

## Concurrency

The shipped default is **two** agents (`worker-1,worker-2`, D12) and the run
spawns them **one after another** — the loop creates a worktree, session and
child process per agent in turn, so two workers do not overlap in wall-clock
time. The admission layer that gates concurrency (default cap 4) is the
`ParallelScheduler`; it is registered and consulted per spawn, but it is **not**
what bounds a run today — the loop is strictly sequential and releases each
worker's slot before requesting the next, so it admits one at a time and never
approaches the cap. §45 says four concurrent subagents and D12 is amended to
two; see
[design drift](../design-drift.md) for the reconciliation.

## Worktrees are scheduling, not isolation

Worktrees separate concurrent writers only. That is scheduling hygiene
— parallel agents not clobbering each other's files — not isolation
and not containment: workers share the user's authority and read the
same untrusted model output. Orchestrator messaging must never imply
otherwise (§59.1). The model is never trusted in either mode, so
approvals plus the change journal stay the controls here too; see
[change journal and safety](journal-and-safety.md).

Merged worktrees and branches are retained as evidence — only
`kubic clean` disposes.

## When to reach for it

One worker process plus a worktree each is the shape for parallelisable
work across distinct areas of a repo. Because every worker runs the same
prompt, a useful `orchestrate` invocations reads like "apply this change
in each of these areas" rather than "do these different things" — until
per-worker prompts land (#103). For everything else — and always by
default — there is [solo](solo.md): one agent, in-process, no
delegation overhead.

Implementation detail lives on the [host package page](../packages/host.md)
and the [worker package page](../packages/worker.md); command
behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also [solo](solo.md) and
[journal and safety](journal-and-safety.md).

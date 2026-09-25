# Orchestrator mode

> Design ref: §5.2, §9.2, §44, §41.1, §45, §59.1 honest limits. Owner:
> issue [#95](https://github.com/konic-labs/kubic/issues/95).
> **Delegation model as shipped (issue #103, 2026-09-25; roles wired by
> #104):** the CLI process is the manager, and its root lane registers the
> §40 toolset and authors the plan whose steps become the prompts its workers
> run — each worker under an assigned §12 role. This page describes that
> model; the part of §9.2 that remains unwired (per-worker approvals) is
> named with the issue that owns it.

Orchestrator is Kubic's opt-in delegation mode: `kubic orchestrate` spawns
one worker process and one git worktree per subagent and merges what they
produce. The mode is session-scoped, requires a git repository — outside
one the request is refused and nothing runs (there is no silent fallback to
solo) — and `run` never delegates.

## How delegation actually works

- **The CLI registers the manager lane, then plans and merges.** The
  `kubic orchestrate` process registers its toolset through the §40
  allowlist before anything spawns — the lane runs with exactly those ten
  tools, and a lane that would carry an exec tool refuses to start rather
  than running with one. It then reads `--agents`, authors a plan (one step
  per worker, in agent order), creates one worktree per agent, spawns one
  child `kubic run` per agent, and settles them through the merge queue.
- **Each worker runs its own plan step, under an assigned role.** The
  manager's plan prompt for a worker cites that worker's step (`step 2 of 3`)
  and carries the run's objective; `-p` is the objective the plan is derived
  from, never a string handed to a worker verbatim. Since issue
  [#104](https://github.com/konic-labs/kubic/issues/104) each worker is also
  assigned one of the five §12 roles and runs that role's resolved tool set:
  the worker prompt is the role document's `## Prompt` text plus the worker's
  step, the child `kubic run` is told `--role <name>` so its own lane
  registers exactly the role's tools (a withheld tool is never registered —
  absence, not approval), and the role's model default travels through the
  existing `KUBIC_MODEL` pin. The plan is stored with the session, so
  `--resume` replays each worker's own composed prompt instead of
  re-deriving one shared text.
- **The CLI commits for the worker; the worker never commits.** A worker child
  is `kubic run`, which does not run `git commit`. After a worker exits 0 the
  orchestrator stages whatever it left on its branch (`git add -A`) and commits
  it under `kubic-worker` provenance, then merges. The invariant that holds is
  about *authorship of the change content*, not about who types `git commit`:
  the manager lane never authors what goes into a worker's change — it does not
  write, edit or apply files, and `assertManagerZeroWrites` proves the recorded
  merge-path trace — the merge plumbing plus the lane's own
  spawn → wait → collect record — stays write-free. Merges are the only write
  the orchestrator performs on the main tree.
- **Merge approvals go to you.** Interactive runs prompt per merge; `--yes`
  auto-approves; a headless run with no decider denies closed (exit 4).
  The *worker* approval layer — requests routed to the user with opt-in
  budgets (§41) — is issue
  [#105](https://github.com/konic-labs/kubic/issues/105).
- **Roles are assigned on this path.** Each worker gets one of the five §12
  roles (issue [#104](https://github.com/konic-labs/kubic/issues/104)): the
  role document's `## Prompt` body and the worker's plan step compose that
  worker's prompt, and the role's resolved tool set is what the worker lane
  registers. `.kubic/roles/*.md` therefore decide what a worker is asked to
  do and which tools exist on its lane; a contradictory document refuses the
  run before anything spawns, and `kubic doctor` prints the same refusal.
- **Conflict delegation, parallel surfacing and retained-worktree status**
  are implemented and unreachable; they are issue
  [#106](https://github.com/konic-labs/kubic/issues/106).

The manager toolset the design fixes in §40 (`spawn_agent`, `wait_for_agent`,
`workspace_merge`, …) is live: `packages/host/src/orchestrator/manager.ts`
exports `MANAGER_ALLOWLIST` and the registration the run validates itself
against, so the allowlist is what constrains delegation on this path — a
requested lane that differs from it refuses to start with the named
`ManagerToolsetError` (exit 1, `code=manager_toolset_refused`). The root is
still the CLI process rather than a model-driven agent; what the lane adds is
the toolset gate and the plan.

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
work across distinct areas of a repo. Each worker runs its own plan step
derived from the objective you pass with `-p`, so an `orchestrate`
invocation reads like "apply this change in each of these areas"; the
worker's assigned role (issue
[#104](https://github.com/konic-labs/kubic/issues/104)) adds the role
document's own prompt text and its resolved tool set on top of that
step. For everything else
— and always by default — there is [solo](solo.md): one agent, in-process,
no delegation overhead.

Implementation detail lives on the [host package page](../packages/host.md)
and the [worker package page](../packages/worker.md); command
behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also [solo](solo.md) and
[journal and safety](journal-and-safety.md).

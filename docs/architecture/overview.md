# Architecture overview

> Owner: issue
> [#62](https://github.com/konic-labs/kubic/issues/62).

Kubic is a terminal coding agent with one architecture and two modes.
**Solo** is the default and the architecture itself: a single agent
working directly in the user's directory. **Orchestrator** is an
opt-in mode for delegation: the `kubic orchestrate` CLI process is the
manager — it registers the §40 manager toolset, plans one step per worker,
fans one worker process plus one git worktree per subagent out and merges
what they produce. Each worker runs under one of the five §12 roles (issue
#104) and its dangerous calls are routed to the user (issue #105). Both modes share the same
safety controls — the
VCS-independent change journal and user-decided approvals.

## Topology

```text
solo (default)                      orchestrator (opt-in, git repos only)
─────────────────────────────       ─────────────────────────────────────
one agent, in-process,              `kubic orchestrate` process (the manager
in the user's directory             in the shipped mode; it delegates and
single trust zone, no isolation     merges, never authors)
                                    ├── worker process + git worktree (subagent A)
                                    ├── worker process + git worktree (subagent B)
controls: approvals + journal       └── … merge what they produce
                                    controls: approvals + journal (unchanged)
```

The shipped manager lane is the CLI process: it registers the §40 manager
toolset, plans one step per worker, and every worker is a child `kubic run`
that runs its own plan step under an assigned role — the role's prompt and
tool set ([#104](https://github.com/konic-labs/kubic/issues/104)) — and a
worker's dangerous call is routed to the user through the run's approval
router ([#105](https://github.com/konic-labs/kubic/issues/105)). See
[orchestrator](orchestrator.md) for the delegation model as shipped.

Solo is the whole story for trust: there is exactly one trust zone —
the user's own authority. Orchestrator adds scheduling (processes and
worktrees that separate concurrent writers) but no new trust boundary.
See [solo](solo.md), [orchestrator](orchestrator.md), and
[change journal and safety](journal-and-safety.md).

## Package map (Wave 0 scaffold)

Verified against the repository tree. Nine packages plus the
composition root:

| Directory | Role |
| --- | --- |
| `packages/core` | Shared contracts both runtimes build on |
| `packages/exec` | Execution environment and change journal; the only package that touches `node:fs` / `node:child_process` |
| `packages/worker` | Solo lane (one pi-durable `Harness` + its root conversation) and worker lifecycle (the executing side) |
| `packages/host` | Host wiring: approvals, orchestrator/manager contracts, worktrees, merge (the delegating side) |
| `packages/agents` | Agent task, roles, budgets, skills |
| `packages/trajectory` | Versioned run records for replay and eval |
| `packages/eval` | Benchmark suites and RL dataset export |
| `packages/tui` | Presentation only; imports contracts from `core`, never `host`/`worker` implementation |
| `packages/extensions` | First-party facet bundles dogfooding the layers below |
| `apps/kubic` | Composition root: wires the packages into the `kubic` CLI |

Dependencies flow one way (`scripts/dep-lint.mjs` enforces it): `tui`
never imports `host`/`worker` implementation, the worker never imports
`host`, and only the app root wires `host` and `tui` together.

**Test contract.** There is no `VirtualTerminal` in the pinned Pi
(`@earendil-works/pi-tui` 1.0.2 exports no such class) and Kubic
declares no terminal-emulator dependency. TUI tests render the pure view
functions directly into headless snapshot strings — no TTY, no alt-screen —
and each view module records that in its header.

Per-package APIs live on the [package pages](../packages/README.md);
command behaviour lives on the [CLI pages](../cli/README.md) — this
section maps the boxes, not their interfaces.

Back to the [docs index](../README.md).

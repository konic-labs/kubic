# Architecture overview

Kubic is a terminal coding agent: a single agent working directly in the
user's directory, in-process, with the user's own authority. Its safety
controls are the VCS-independent change journal and user-decided
approvals.

## Topology

```text
one agent, in-process, in the user's directory
single trust zone, no isolation
controls: approvals + journal
```

There is exactly one trust zone — the user's own authority. See
[solo](solo.md) and [change journal and safety](journal-and-safety.md).

## Package map

Eight packages plus the composition root:

| Directory | Role |
| --- | --- |
| `packages/core` | Shared contracts the packages build on |
| `packages/exec` | Execution environment and change journal; the only package that touches `node:fs` / `node:child_process` |
| `packages/agent` | The agent lane: one pi-durable `Harness` and its root conversation |
| `packages/host` | Host wiring: config, approvals, models, sessions, audit, the command handlers |
| `packages/agent` | Permission policy and skills |
| `packages/trajectory` | Versioned run records for replay and eval |
| `packages/eval` | Benchmark suites and RL dataset export |
| `packages/tui` | Presentation only; imports contracts from `core`, never `host`/`worker` implementation |
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

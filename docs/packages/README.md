# Package pages

One page per package (owner: issue
[#63](https://github.com/konic-labs/kubic/issues/63)). Each page
documents its package's public API, contracts, and dep-direction
neighbours — no architecture rationale, no CLI usage.

- [core.md](core.md) — `packages/core`
- [exec.md](exec.md) — `packages/exec`
- [worker.md](worker.md) — `packages/worker`
- [host.md](host.md) — `packages/host`
- [agents-pkg.md](agents-pkg.md) — `packages/agents`
- [trajectory.md](trajectory.md) — `packages/trajectory`
- [eval.md](eval.md) — `packages/eval`
- [tui.md](tui.md) — `packages/tui`
- [extensions.md](extensions.md) — `packages/extensions`

## Import direction (matches `scripts/dep-lint.mjs`)

One-way dependencies: packages may only import "downward". The diagram
below is the allowlist — any edge not shown here is a lint violation
(run `node scripts/dep-lint.mjs`).

```text
@kubic/core                      ← imports nothing internal; imported by all
  ↑         ↑          ↑
@kubic/exec  @kubic/agents  @kubic/trajectory   ← core only
  ↑    ↑          ↑                ↑
  │    └──────────┼────────────────┼──→ @kubic/worker   ← core, exec, agents (+ snapshots)
  │               │                │         ↑
  │               │                │   @kubic/host      ← core, exec, worker, agents, trajectory, eval
  │               │                │         ↑
  │               │                └──→ @kubic/eval     ← core, agents, trajectory
  │               │
  │               └──→ @kubic/extensions  ← core, exec, agents, trajectory, eval
  │                        (never worker/host/tui implementation, never apps/kubic)
  │
@kubic/tui  ← core only (never host/worker implementation)

apps/kubic  ← composition root: wires host + tui together
```

I/O confinement (§9): only `@kubic/exec` touches
`node:fs`/`node:child_process`. Pi seams (§65): `@kubic/worker` via
`src/pi-boundary.ts` only, `@kubic/tui` via `src/tui-boundary.ts` only.

Back to the [docs index](../README.md).

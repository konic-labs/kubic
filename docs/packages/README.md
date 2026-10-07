# Package pages

One page per package. Each page
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

## Import direction (matches `scripts/dep-lint.mjs`)

One-way dependencies: packages may only import "downward". The diagram
below summarizes the allowed direction — the allowlist itself lives in
`scripts/dep-lint.mjs` (`npm run lint:deps`); if the two disagree, the
lint governs.

```text
@kubic/core         ← imports nothing internal; imported by all
@kubic/exec         ← core
@kubic/trajectory   ← core
@kubic/agents       ← core, exec
@kubic/eval         ← core, agents, trajectory
@kubic/worker       ← core, exec, agents, trajectory, eval
@kubic/host         ← core, exec, worker, agents, trajectory, eval
@kubic/tui          ← core only (never host/worker implementation)
apps/kubic          ← composition root: wires host + tui together
```

I/O confinement (component split; enforced by
`scripts/dep-lint.mjs`): only `@kubic/exec` touches
`node:fs`/`node:child_process`, with test scaffolding exempt. Pi seams:
`@kubic/worker` via `src/pi-boundary.ts` only, `@kubic/tui` via
`src/tui-boundary.ts` only.

Back to the [docs index](../README.md).

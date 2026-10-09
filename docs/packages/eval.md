# `@kubic/eval`

> The benchmark harness and the training-data export.
> Source: `packages/eval/src`; adding a suite:
> [`packages/eval/COMMUNITY.md`](../../packages/eval/COMMUNITY.md).

`@kubic/eval` runs benchmark suites through the real lane, scores the
trajectory each run writes, and turns trajectories into datasets
(`kubic eval`, `kubic benchmark`, `kubic export`; the commands are on the
[analysis page](../cli/analysis.md)).

- **A result says how it ran.** Every stored record carries the model, the
  thinking level, the worktree, its size and its determinism tier; one that
  misses any of them is rejected (exit 2), never stored. Its cost, tokens and
  latency must reconcile with the session's usage rows before it is accepted.
- **A suite is a fixture.** Each executable suite carries a prompt, starting
  files and gate commands, and runs faux-only in CI: zero network, zero paid
  tokens. A suite that needs something the binary does not ship (a live PTY)
  stays `stub: true` and reports `skipped`, never passing work.
- **Signals are never guessed.** The gate signals (`tests`, `build`, `lint`,
  `typecheck`) come from the trajectory's `signal:<name>` labels, which the
  run verifier (`packages/host/src/run/verifier.ts`) writes from the
  [`[verify]` commands](../cli/configuration.md#gate-verification-verify);
  without a label a gate is `unknown`. A red gate vetoes success.
  `regressionFree` reads the verifier's `signal:regression` (the same gates
  run at the base revision) and, with no baseline, means "completed with no
  red gate".
- **Patch quality** is graded in [0, 1]: 0 when the run did not complete,
  otherwise the share of known gates that pass (1 when none is known), halved
  on a regression. tests, build and typecheck passing with lint failing is
  0.75; with a regression, 0.375.

## Entry points

| Entry point | What it holds |
| --- | --- |
| `@kubic/eval/cli` | `kubic eval` and `kubic benchmark`: one validated record, or the matrix over the built-in suites |
| `@kubic/eval/export-cli` | `kubic export`: describe one trajectory, or stream a dataset (`--dataset`) as JSONL with a manifest |
| `@kubic/eval/runner` | Runs a suite's fixture through an injected lane runner, or scores a recorded trajectory |
| `@kubic/eval/signals` | The gate signals, `regressionFree` and patch quality, computed from a parsed trajectory |
| `@kubic/eval/suites` | The built-in suites, one per category (`swe`, `repo-mod`, `bugfix`, `refactor`, `testgen`, `review`, `terminal`, `agentic`) |
| `@kubic/eval/rl/preference` | Preference pairs across a run boundary |
| `@kubic/eval/rl/verifier` | The reference verifier: `pass` needs `signal:tests = pass` and no red gate, so verified runs feed rewards and pairs without hand-set labels |
| `@kubic/eval/test-support/fixtures` | Test-only builders for the export tests |

## Neighbours

- Imports: [@kubic/core](core.md) and [@kubic/trajectory](trajectory.md),
  whose `parseTrajectoryExport` it reads exports with; never exec, agent,
  host or tui.
- Imported by: the composition root, which hands the runner a real lane.

```text
core + trajectory ──→ @kubic/eval ──→ benchmark matrix, datasets
```

Back to the [docs index](../README.md).

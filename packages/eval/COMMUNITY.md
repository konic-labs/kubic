# Community eval contributions

Anyone can add a benchmark suite. The path is stub-first: land the suite
as `stub: true`, then implement it — the matrix reports stubs as
`skipped` (never as passing work), so a stub can never fake a green
board.

## 1. Add the suite

Append one row to `EVAL_SUITES` in `packages/eval/src/suites.ts`:

```ts
{
  id: 'my-suite',
  category: 'bugfix', // one of the 8 EVAL_CATEGORIES
  title: 'My suite',
  stub: true, // flip to false once the fixture below runs
  description: 'What signal it measures.',
  // An executable suite carries a fixture:
  // fixture: {
  //   task: 'Plain-language task a real model can follow.',
  //   fauxPrompt: 'faux:tool write {"path":"out.txt","content":"ok\\n"}',
  //   files: { 'check.sh': 'grep -q ok out.txt\n' },
  //   verify: { tests: 'sh check.sh' },
  // },
}
```

Rules:

- `id` is unique, lowercase, hyphenated.
- `category` is one of `swe`, `repo-mod`, `bugfix`, `refactor`,
  `testgen`, `review`, `terminal`, `agentic`.
- Each executable suite gives two tasks: `task`, the plain language a
  real model reads, and `fauxPrompt`, the script the faux provider runs —
  both must pass the suite's gates when done right.
- Suites must run faux-only (zero network, zero paid tokens) in CI.
  Anything needing a capability the binary does not ship (a live PTY)
  stays `stub: true`; a faux-drivable fixture is executable.

## 2. Run it

```sh
# Single eval: run a prompt against the suite's fixture and gates
kubic eval --task "fix the widget" --suite my-suite \
  --model anthropic/claude-sonnet-5-5 --worktree /wt/eval-1 \
  --size smoke --json

# Score an existing trajectory file without re-running it (`-` reads stdin)
kubic eval --trajectory run.trajectory.json --suite my-suite \
  --model faux/echo --worktree /wt/eval-1 \
  --size smoke --json

# Full matrix (or one suite): each suite runs its own task — the scripted
# one on the faux provider, the plain-language one on a real model. A clean
# worktree is required with --workspace worktree
kubic benchmark --suite my-suite --workspace worktree \
  --model faux/echo --worktree /wt/eval-1 \
  --size smoke --json
```

`--size` is mandatory on every invocation, and `--worktree` is mandatory
for `--task` and `benchmark` (a `--trajectory` run takes it from the
export). Records missing a mandatory flag are rejected (exit 2), never
stored.

Every record carries `success`, `costUsd`, `tokens`, `latencyMs`,
`toolCalls`, `model`, `thinking`, `worktree`, `size`, and `determinism`
(`recorded` for `--trajectory`, `live` for `--task`).

## 3. `--json` shapes

Eval success:

```json
{ "ok": true, "exitCode": 0, "record": { "suite": "…", "success": true } }
```

Eval rejection (usage/error, exit 2):

```json
{ "ok": false, "exitCode": 2, "error": { "code": "missing-size", "message": "…" } }
```

Benchmark matrix (exit 0 all pass, 1 a suite failed, 2 usage):

```json
{
  "ok": true,
  "exitCode": 0,
  "results": [
    { "suite": "…", "category": "swe", "stub": false, "skipped": false, "success": true }
  ]
}
```

## 4. Checklist before review

- [ ] New suite has ≥1 test in `packages/eval/src/` (test first).
- [ ] `npx vitest run packages/eval` green.
- [ ] `npx tsc --noEmit -p tsconfig.base.json` clean.
- [ ] `npx biome ci packages/eval` clean.
- [ ] Cost/latency/tokens reconcile with the usage rows
      (`reconcileUsage`).
- [ ] RL export fields untouched — records stay complete
      so the exporter can build on them.

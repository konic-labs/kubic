# Community eval contributions (§76.1)

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
  stub: true, // flip to false when it runs faux-only
  description: 'What signal it measures.',
}
```

Rules:

- `id` is unique, lowercase, hyphenated.
- `category` is one of `swe`, `repo-mod`, `bugfix`, `refactor`,
  `testgen`, `review`, `terminal`, `agentic`.
- Suites must run faux-only (zero network, zero paid tokens) in CI.
  Anything needing a live PTY or live model stays `stub: true`.

## 2. Run it

```sh
# Single eval against a task prompt
kubic eval --task "fix the widget" --suite my-suite \
  --model faux/faux --worktree /wt/eval-1 --generation 1 \
  --tier smoke --json

# Score an existing trajectory without re-running it
kubic eval --trajectory "$(cat run.trajectory.json)" --suite my-suite \
  --model faux/faux --worktree /wt/eval-1 --generation 1 \
  --tier smoke --json

# Full matrix (or one suite) — clean worktree required with
# --workspace worktree
kubic benchmark --suite my-suite --workspace worktree \
  --model faux/faux --worktree /wt/eval-1 --generation 1 \
  --tier smoke --json
```

`--worktree`, `--generation`, and `--tier` are mandatory: records
missing any of them are rejected (exit 2), never stored. Every record
carries `success`, `costUsd`, `tokens`, `latencyMs`, `toolCalls`,
`model`, `thinking`, `worktree`, `generation`, and `tier`.

## 3. `--json` shapes

Eval success:

```json
{ "ok": true, "exitCode": 0, "record": { "suite": "…", "success": true } }
```

Eval rejection (usage/error, exit 2):

```json
{ "ok": false, "exitCode": 2, "error": { "code": "missing-tier", "message": "…" } }
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

- [ ] New suite has ≥1 test in `packages/eval/src/` (TDD: RED first).
- [ ] `npx vitest run packages/eval` green.
- [ ] `npx tsc --noEmit -p tsconfig.base.json` clean.
- [ ] `npx biome ci packages/eval` clean.
- [ ] Cost/latency/tokens reconcile with the §39 usage rows
      (`reconcileUsage`).
- [ ] RL export fields (Phase 4, #54) untouched — records stay complete
      so the exporter can build on them.

# Dead-surface ledger (issue #102)

Every non-test source file that no runtime path reaches gets an owner here:
an issue that wires it, `delete`, or `keep:` with the reason. The gate
(`scripts/reachability.mjs`) recomputes reachability from the binary entry
(`apps/kubic/src/main.ts`, the only module `bin/kubic.js` can reach) by
walking VALUE imports — `import type` is erased and never makes a file
reachable — and fails when a dead file has no row here, when a row names a
file that no longer exists, or when a row's file has become reachable
(dispositions must be executed, not forgotten).

- Method: BFS over `import` / `import()` specifiers, `.js` specifiers
  resolved to `.ts` sources, `packages/*/src` + `apps/*/src`, excluding
  `*.test.ts`, `pi/`, `dist/`, `node_modules/`. Recompute with
  `node scripts/reachability.mjs --report` (`--json` for machines).
- Ledger counts only move down, or move with a named justification for a new
  intentionally-kept seam. No `TODO`/`FIXME` marks dead code: this file is
  the single place that tracks it.
- The counts below were computed on `main@1e41191`; rows for files that later
  became reachable are removed as the owning issue lands (issue #92 wired
  `clean.ts`, `confinement.ts`, `list.ts` and `remove.ts`; its row for
  `worktree/index.ts` stands — that barrel is still dead). Issue #97 deleted
  `packages/exec/src/{effects,checkpoint-store}.ts` (its rows are gone; the
  surface is a documented deletion, not a wired seam). `#102` itself owns
  the 22 reserved `export {};` stubs (delete) and the dead barrels; the wiring
  clusters belong to the sibling issues named in each row.
- Issue #95 re-scoped the manager lane and executed its orchestrator
  dispositions: **deleted** the dead barrels
  (`orchestrator/{approvals,merge,parallel,worktree}/index.ts`,
  `policy/index.ts` — no importer anywhere), **wired**
  `packages/agents/src/graph.ts` (§54 delegation DAG rendered by
  `orchestrate-cli.ts` → `delegationGraphLines`) and
  `limits/orchestrator-notice.ts` (emitted once per run at the first spawn
  site in `apps/kubic/src/orchestrate-run.ts`, its row is gone), and gave the
  remaining dead orchestrator modules **named-issue** owners: `manager.ts`
  (#103), `approvals/{budgets,request,routing,skip}.ts` (#105),
  `merge/conflicts.ts` + `parallel/visibility.ts` + `worktree/status.ts`
  (#106). No orchestrator row is owned by #95 any more.
- Issue #93 executed two of its six rows: `bundles/budget/worker.ts` (the
  worker facet now gates live tool calls through the startup object) and
  `src/index.ts` (the composition root imports the package surface). The four
  remaining #93 rows (`cancellation.ts`, `facets.ts`, `replicated.ts`,
  `secrets.ts`) stay dead: the loading path this issue adds does not consume
  them, and they keep their existing owner rather than being claimed wired.
  its whole `ops/cost/*` + `ops/perf/*` cluster — see below.
- Issue #89 executed its row: `packages/host/src/limits/solo-warning.ts` is
  reachable now that the composition root emits the no-isolation notice on
  `run` (stderr before the first turn) and `tui` (editor footer), so the row
  is removed rather than kept.

| LOC | file | owner | disposition |
| --- | --- | --- | --- |
| 728 | `packages/agents/src/artifacts.ts` | #99 | wire: context contracts (#99) |
| 4 | `packages/agents/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/agents/src/lifecycle.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 533 | `packages/agents/src/memory.ts` | #99 | wire: context contracts (#99) |
| 4 | `packages/agents/src/roles.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 485 | `packages/agents/src/skills/skills.ts` | #99 | wire: context contracts (#99) |
| 338 | `packages/agents/src/skills/templates.ts` | #99 | wire: context contracts (#99) |
| 501 | `packages/agents/src/spec.ts` | #99 | wire: context contracts (#99) |
| 133 | `packages/agents/src/task.ts` | #99 | wire: context contracts (#99) |
| 142 | `packages/agents/src/transfer.ts` | #99 | wire: context contracts (#99) |
| 4 | `packages/core/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/core/src/policy.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 95 | `packages/core/src/presentation.ts` | #96 | wire: TUI view contract (#96); imported only by dead transcript/tui-app |
| 4 | `packages/core/src/protocol.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/core/src/session.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 49 | `packages/eval/src/index.ts` | #101 | delete: dead barrel over the live eval CLI |
| 84 | `packages/eval/src/rl/fixtures.ts` | #99 | wire: RL dataset export (phase 4, design §53) — keep behind the eval CLI |
| 58 | `packages/eval/src/rl/index.ts` | #99 | wire: RL dataset export (phase 4, design §53) — keep behind the eval CLI |
| 4 | `packages/exec/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/exec/src/paths.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/exec/src/workspace.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 58 | `packages/extensions/src/cancellation.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 55 | `packages/extensions/src/facets.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 80 | `packages/extensions/src/replicated.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 45 | `packages/extensions/src/secrets.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 7 | `packages/host/src/config/index.ts` | #102 | delete: dead barrel over the now-live config modules (runtime.ts imports them per-module path, per docs/packages/host.md's "no barrel" convention) |
| 4 | `packages/host/src/credentials.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/host/src/dispatch.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 151 | `packages/host/src/handoff.ts` | #99 | wire: handoff contract (#99); AgentResult import is type-only |
| 4 | `packages/host/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 117 | `packages/host/src/limits/skip-records.ts` | #86 | wire: full-access skip records surface with approvals (#86/#48) |
| 18 | `packages/host/src/limits/trust-first.ts` | #100 | wire: docs ordering note consumed by help/docs rendering (#100) |
| 353 | `packages/host/src/orchestrator/approvals/budgets.ts` | #105 | wire: per-worker approvals + opt-in budgets (#105) |
| 242 | `packages/host/src/orchestrator/approvals/request.ts` | #105 | wire: per-worker approvals + opt-in budgets (#105) |
| 282 | `packages/host/src/orchestrator/approvals/routing.ts` | #105 | wire: per-worker approvals + opt-in budgets (#105) |
| 151 | `packages/host/src/orchestrator/approvals/skip.ts` | #105 | wire: per-worker approvals + opt-in budgets (#105) |
| 327 | `packages/host/src/orchestrator/manager.ts` | #103 | wire: manager lane + plan → distinct worker prompts (#103) |
| 309 | `packages/host/src/orchestrator/merge/conflicts.ts` | #106 | wire: conflict delegation, parallel surfacing, retained-worktree status (#106) |
| 39 | `packages/host/src/orchestrator/merge/telemetry.ts` | #98 | wire: merge telemetry through spans (#98); imported only by dead merge-report/index |
| 78 | `packages/host/src/orchestrator/parallel/visibility.ts` | #106 | wire: conflict delegation, parallel surfacing, retained-worktree status (#106) |
| 128 | `packages/host/src/orchestrator/worktree/status.ts` | #106 | wire: conflict delegation, parallel surfacing, retained-worktree status (#106) |
| 419 | `packages/host/src/roles/resolver.ts` | #99 | wire: role documents parsed and applied (#99) |
| 144 | `packages/host/src/roles/roles-data.ts` | #99 | wire: role documents parsed and applied (#99) |
| 4 | `packages/host/src/root-agent.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/host/src/worker-manager.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 399 | `packages/trajectory/src/export.ts` | #99 | wire: trajectory export reachable from the CLI (#78 landed the command; the exporter stays behind a dead barrel) |
| 56 | `packages/trajectory/src/index.ts` | #99 | delete: dead barrel over export.ts |
| 410 | `packages/tui/src/approval-view.ts` | #96 | wire: TUI approval/diff/journal views (#96) |
| 5 | `packages/tui/src/components.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 175 | `packages/tui/src/diff-view.ts` | #96 | wire: TUI approval/diff/journal views (#96) |
| 6 | `packages/tui/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 93 | `packages/tui/src/journal-view.ts` | #96 | wire: TUI approval/diff/journal views (#96) |
| 5 | `packages/tui/src/views.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 5 | `packages/worker/src/approval-client.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/worker/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/worker/src/session.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/worker/src/tools.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |

## Executed by #98 (the `ops/cost/*` + `ops/perf/*` cluster)

Issue #98's rows are gone because the dispositions were executed, not
rewritten. Two halves:

- **Wired** (rows removed, files now reachable from the binary):
  - `packages/host/src/spans.ts` — the §49.3 recorder now has a live
    caller: `ops/perf/run-spans.ts`, driven by `apps/kubic/src/headless-run.ts`.
  - `packages/host/src/ops/cost/cache.ts` — `prefixHitRate` /
    `transparentCachingNote` now run over the real `cacheRead`/`cacheWrite`
    counters on `kubic cost` rows (`ops/cost/cost-cli.ts`).
  - `packages/host/src/ops/perf/{budgets,perf-cli}.ts` were already live and
    stay live; `perf-cli.ts` gained the `--measure` path (new
    `ops/perf/measure.ts`).
- **Deleted** (no live substrate existed; deleting beats a fake caller):
  - `ops/cost/{index,compact-reuse,escalation,order,output-limits,response-cache,retry-ledger,role-model,spawn-gate}.ts`
    — §62 levers 3–8. Each had zero non-test importers outside its own
    barrel; the barrel itself was dead. Wiring them would have meant
    inventing callers for compaction, escalation, output limiting, a
    response cache and a spawn gate that the shipped solo path does not
    have.
  - `ops/perf/{index,concurrency,merge-report,spans,spawn-path}.ts` —
    a dead barrel plus §55 reporting helpers whose subjects (aggregate
    admission, merge telemetry, the worker.start chain, the cheap-spawn
    taxonomy) are owned by the orchestrator work (#94/#95) and were
    unreachable from the binary.

The §61 worker lifecycle budgets (`packages/worker/src/lifecycle/budgets.ts`)
are NOT part of this cluster: their wiring belongs to #94.

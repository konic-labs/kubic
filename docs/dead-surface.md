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
- Issue #93 executed two of its six rows: `bundles/budget/worker.ts` (the
  worker facet now gates live tool calls through the startup object) and
  `src/index.ts` (the composition root imports the package surface). The four
  remaining #93 rows (`cancellation.ts`, `facets.ts`, `replicated.ts`,
  `secrets.ts`) stay dead: the loading path this issue adds does not consume
  them, and they keep their existing owner rather than being claimed wired.

| LOC | file | owner | disposition |
| --- | --- | --- | --- |
| 728 | `packages/agents/src/artifacts.ts` | #99 | wire: context contracts (#99) |
| 314 | `packages/agents/src/graph.ts` | #99 | wire: context contracts (#99) |
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
| 13 | `packages/host/src/limits/orchestrator-notice.ts` | #95 | wire: orchestrator worktree messaging at the spawn site (#95) |
| 117 | `packages/host/src/limits/skip-records.ts` | #86 | wire: full-access skip records surface with approvals (#86/#48) |
| 28 | `packages/host/src/limits/solo-warning.ts` | #89 | wire: emit the solo no-isolation warning on run/tui (#89) |
| 18 | `packages/host/src/limits/trust-first.ts` | #100 | wire: docs ordering note consumed by help/docs rendering (#100) |
| 48 | `packages/host/src/ops/cost/cache.ts` | #98 | wire: real measurements or delete (#98) |
| 51 | `packages/host/src/ops/cost/compact-reuse.ts` | #98 | wire: real measurements or delete (#98) |
| 78 | `packages/host/src/ops/cost/escalation.ts` | #98 | wire: real measurements or delete (#98) |
| 52 | `packages/host/src/ops/cost/index.ts` | #98 | wire: real measurements or delete (#98) |
| 62 | `packages/host/src/ops/cost/order.ts` | #98 | wire: real measurements or delete (#98) |
| 28 | `packages/host/src/ops/cost/output-limits.ts` | #98 | wire: real measurements or delete (#98) |
| 53 | `packages/host/src/ops/cost/response-cache.ts` | #98 | wire: real measurements or delete (#98) |
| 56 | `packages/host/src/ops/cost/retry-ledger.ts` | #98 | wire: real measurements or delete (#98) |
| 69 | `packages/host/src/ops/cost/role-model.ts` | #98 | wire: real measurements or delete (#98) |
| 27 | `packages/host/src/ops/cost/spawn-gate.ts` | #98 | wire: real measurements or delete (#98) |
| 31 | `packages/host/src/ops/perf/concurrency.ts` | #98 | wire: real measurements or delete (#98) |
| 37 | `packages/host/src/ops/perf/index.ts` | #98 | wire: real measurements or delete (#98) |
| 22 | `packages/host/src/ops/perf/merge-report.ts` | #98 | wire: real measurements or delete (#98) |
| 53 | `packages/host/src/ops/perf/spans.ts` | #98 | wire: real measurements or delete (#98) |
| 40 | `packages/host/src/ops/perf/spawn-path.ts` | #98 | wire: real measurements or delete (#98) |
| 353 | `packages/host/src/orchestrator/approvals/budgets.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 80 | `packages/host/src/orchestrator/approvals/index.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 242 | `packages/host/src/orchestrator/approvals/request.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 282 | `packages/host/src/orchestrator/approvals/routing.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 151 | `packages/host/src/orchestrator/approvals/skip.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 327 | `packages/host/src/orchestrator/manager.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 309 | `packages/host/src/orchestrator/merge/conflicts.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 55 | `packages/host/src/orchestrator/merge/index.ts` | #95 | delete: barrel over dead modules; #95 reconciles the orchestrator leftovers |
| 39 | `packages/host/src/orchestrator/merge/telemetry.ts` | #98 | wire: merge telemetry through spans (#98); imported only by dead merge-report/index |
| 49 | `packages/host/src/orchestrator/parallel/index.ts` | #95 | delete: barrel over dead modules; #95 reconciles the orchestrator leftovers |
| 78 | `packages/host/src/orchestrator/parallel/visibility.ts` | #95 | wire: manager lane + subagent approvals (#95) |
| 128 | `packages/host/src/orchestrator/worktree/status.ts` | #92 | wire: kubic clean / worktree lifecycle (#92) |
| 63 | `packages/host/src/orchestrator/worktree/index.ts` | #92 | delete: dead barrel over the worktree modules (issue #92 wired its siblings, not the barrel) |
| 5 | `packages/host/src/policy/index.ts` | #95 | delete: barrel over dead modules; #95 reconciles the orchestrator leftovers |
| 419 | `packages/host/src/roles/resolver.ts` | #99 | wire: role documents parsed and applied (#99) |
| 144 | `packages/host/src/roles/roles-data.ts` | #99 | wire: role documents parsed and applied (#99) |
| 4 | `packages/host/src/root-agent.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 206 | `packages/host/src/spans.ts` | #98 | wire: real measurements or delete (#98) |
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
| 157 | `packages/worker/src/lane/events.ts` | #102 | keep: seam — reachable once the owning issue wires it |
| 4 | `packages/worker/src/session.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/worker/src/tools.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |

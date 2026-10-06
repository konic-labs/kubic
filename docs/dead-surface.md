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
  (#106). No orchestrator row is owned by #95 any more. (Of those, `manager.ts`
  and the four `approvals/*.ts` modules have since been wired — #103 and #105
  respectively — and their rows removed.)
- Issue #103 executed its one row: **wired**
  `packages/host/src/orchestrator/manager.ts` — the live `kubic orchestrate`
  run registers its lane through `registerManagerLane`/`MANAGER_ALLOWLIST`
  (a lane with an exec tool refuses to start) and authors the plan whose
  steps are the per-worker prompts, so the module is reachable from the
  binary and its row is removed rather than kept.
- Issue #105 executed its four rows: **wired** the whole orchestrator
  approval layer — `orchestrator/approvals/request.ts` (the provenance-bound
  envelope), `routing.ts` (the router: user-decider routing, bounded waits,
  durable decisions, the read-only manager indicator), `budgets.ts` (opt-in
  per-spawn budgets, self-raise refused) and `skip.ts` (the session-scoped
  full-access posture) — through the new live constructor
  `orchestrator/approvals/worker-asks.ts`, which the composition root builds in
  `apps/kubic/src/orchestrate-run.ts` and the run drives from
  `orchestrate-cli.ts`. A worker child reaches the same layer through the ask
  mailbox, so no row for the cluster remains.
- Issue #93 executed two of its six rows: `bundles/budget/worker.ts` (the
  worker facet now gates live tool calls through the startup object) and
  `src/index.ts` (the composition root imports the package surface). The four
  remaining #93 rows (`cancellation.ts`, `facets.ts`, `replicated.ts`,
  `secrets.ts`) stay dead: the loading path this issue adds does not consume
  them, and they keep their existing owner rather than being claimed wired.
  its whole `ops/cost/*` + `ops/perf/*` cluster — see below.
- Issue #99 wired the roles half on the live solo path: `packages/host/
  src/roles/resolver.ts` is reachable through
  `packages/host/src/roles/roles-boot.ts` (loaded by
  `apps/kubic/src/headless-run.ts` for `kubic run --role`, with
  `roleDoctorChecks` surfaced through doctor's `probeRoles` seam), so its
  row is gone. `roles-data.ts` is reachable too: the delegation path (#104)
  consumes its role list and thinking defaults through `worker-roles.ts`, so
  its row is gone as well.
- Issue #99 executed the **delete** half of its table as well: `packages/agents/src/artifacts.ts`, `memory.ts`, `transfer.ts` and `packages/host/src/handoff.ts` had zero non-test importers and no honest consumer on the shipped path, so they were deleted with their tests rather than wired to an invented caller (the sibling issues' standard: a fabricated caller is worse than a deletion). The design sections those modules implemented — §24/§25 (context isolation/sharing, transfer grants) are enforced by structure instead: the shipped delegation hands each worker PROCESS an argv prompt and a session id, never a parent transcript, so there is nothing to validate at object level; §28 (memory lifetimes) has no live path — the harness session store is the only persistence; §69 (no-transcript guarantee) holds by construction on the process boundary. The sections are recorded as **not-yet-implemented** in [design-drift](design-drift.md) because the design document itself is local-only.
- Issue #99 executed the skills half of its scope: **wired**
  `packages/agents/src/skills/skills.ts` (`discoverSkills` +
  `formatSkillsForSystemPrompt` run at solo boot through
  `packages/host/src/skills-boot.ts`, honouring `--no-skills` and the
  untrusted-cwd exclusion — its row is gone) and gave the inert contracts
  **deletions** where no honest consumer exists (`skills/templates.ts`,
  `artifacts.ts`, `memory.ts`, `transfer.ts`,
  `host/src/handoff.ts`). Roles wire on the live path. Not deletable and
  not dead, so no row: `budget.ts` (the scheduler imports `RunMode`, the
  extensions bundle imports `createBudget`) and `graph.ts` (live via #95).
  `spec.ts` keeps a re-owned row; `task.ts` moves to a `keep:` reason.
- Issue #89 executed its row: `packages/host/src/limits/solo-warning.ts` is
  reachable now that the composition root emits the no-isolation notice on
  `run` (stderr before the first turn) and `tui` (editor footer), so the row
  is removed rather than kept.
- Issue #96 executed its three rows: `packages/tui/src/diff-view.ts`,
  `journal-view.ts` and `approval-view.ts` are all reached from the binary now.
  The first two through `view-panel.ts` → `tui-app.ts` (the `Ctrl-O` diff panel
  and the `Ctrl-R` journal panel) — reachable at import level since #96, and
  fed with rows in production only since issue #311 (`tui-run.ts` reads the
  session journal through `diffEntries` into `setJournalChanges`; before that
  both panels always showed `no changes`); `approval-view.ts` through
  `approval-surface.ts`, which is the answer seat the installed policy consults
  when a challenged call is deferred — the overlay the TUI was designed around
  and the inline fallback both render from it.
- Issue #106 executed all three of its rows: **wired**
  `packages/host/src/orchestrator/parallel/visibility.ts` (the live run builds
  the §49.1 tree line, the §50 workers-extra row — running/queued/cap — and
  the §49.1 trajectory event for a queued spawn),
  `packages/host/src/orchestrator/merge/conflicts.ts` (a genuine merge
  conflict is delegated: `dispatchResolverSpec` builds the writer-resolver spec
  from the manager's own live approval snapshot — hash recomputed inside,
  snapshot frozen, no second policy — and the composition root spawns a real
  resolver child that settles the worker's branch; the manager re-merges, and
  only a successful re-merge settles the candidate) and
  `packages/host/src/orchestrator/worktree/status.ts` (each retained worktree
  reports its measured dirtiness after the run, naming the files when it is
  dirty and `clean=unknown` when the status cannot be read). All three are
  reachable from the binary now, so their rows are removed rather than kept.
- The orchestrator-group commander migration (orchestrate, clean, workers)
  **wired** four cli-foundation rows: `packages/core/src/cli/{logger,output,table,theme}.ts`
  are reachable from the binary through `host/src/orchestrate-cli.ts`,
  `host/src/orchestrator/worktree/clean.ts` and `host/src/workers-cli.ts`
  (diagnostics via the consola logger, `--json` via `formatJson`, the
  `kubic workers` table, the report colours), so their rows are removed.
  `prompt.ts` is reachable too: `sessions prune` asks through
  `promptConfirm`, its only helper (the unused select/text/spinner helpers
  were deleted rather than ledgered).
- Issue #383 **wired** `packages/trajectory/src/export.ts`: every settled
  `kubic run`, orchestrator worker child and TUI turn writes its §46
  trajectory through `buildTrajectoryExport`
  (`host/src/trajectory/run-trajectory.ts`), so its row is removed. The
  `trajectory/src/index.ts` barrel cannot be deleted (a §64 skeleton path
  pinned by `scripts/dep-lint.test.mjs`); its row is re-owned from `delete:`
  to a named `keep:`.
- Issue #211 executed a function-level **delete**: `applySelectedRole` +
  `validateRoleToolsRegistered` in the live
  `packages/host/src/roles/roles-boot.ts` had zero callers anywhere (the
  solo boot applies roles inline via `selectRole`/`rolePromptFor`, the
  delegation path via `worker-roles.ts`), so they were deleted rather than
  wired to an invented caller. Function-level, in a reachable file — no
  ledger row.

| LOC | file | owner | disposition |
| --- | --- | --- | --- |
| 98 | `packages/tui/src/ui/match.ts` | #460 | keep: EPIC N TUI kit (#452), wired by the TUI issues #453–#466 |
| 4 | `packages/agents/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/agents/src/lifecycle.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/agents/src/roles.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |

| 4 | `packages/core/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/core/src/policy.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/core/src/protocol.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/core/src/session.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 49 | `packages/eval/src/index.ts` | #101 | delete: dead barrel over the live eval CLI |
| 84 | `packages/eval/src/rl/fixtures.ts` | #99 | wire: RL dataset export (phase 4, design §53) — keep behind the eval CLI |
| 58 | `packages/eval/src/rl/index.ts` | #99 | wire: RL dataset export (phase 4, design §53) — keep behind the eval CLI |
| 4 | `packages/exec/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/exec/src/paths.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 225 | `packages/exec/src/test-support/git-sandbox.ts` | #365 | keep: test-only real-git sandbox factory (scrubbed env, activated process.env, `git`/`gitResult` runners) imported exclusively by `*.test.ts` files, which the value-import walk excludes by rule — a test seam can never be `reachable` |
| 60 | `packages/exec/src/test-support/orchestrate-lane-fixtures.ts` | #431 | keep: test-only lane-worker child script (self-scrubbed git view, pinned commit identity) imported exclusively by the #431 prod acceptance — same test-seam exclusion as the git sandbox |
| 4 | `packages/exec/src/workspace.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 58 | `packages/extensions/src/cancellation.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 55 | `packages/extensions/src/facets.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 80 | `packages/extensions/src/replicated.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 45 | `packages/extensions/src/secrets.ts` | #93 | wire: first-party bundle loaded at startup (#93) |
| 7 | `packages/host/src/config/index.ts` | #102 | delete: dead barrel over the now-live config modules (runtime.ts imports them per-module path, per docs/packages/host.md's "no barrel" convention) |
| 4 | `packages/host/src/credentials.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/host/src/dispatch.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/host/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 18 | `packages/host/src/limits/trust-first.ts` | #100 | wire: docs ordering note consumed by help/docs rendering (#100) |
| 94 | `packages/exec/src/test-support/orchestrate-conflict-fixtures.ts` | #420 | keep: test-only resolver-child scripts (self-scrubbed git view, committed through scrubbed env) imported exclusively by `apps/kubic/src/orchestrate-conflict-prod.test.ts` (moved from `packages/host` by #387), which the value-import walk excludes by rule — a test seam can never be `reachable` |

| 4 | `packages/host/src/root-agent.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/host/src/worker-manager.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 56 | `packages/trajectory/src/index.ts` | #383 | keep: §64 skeleton path pinned by `scripts/dep-lint.test.mjs` (REQUIRED_PATHS), so it cannot be deleted; the live path imports `export.ts`/`schema.ts` per module |
| 5 | `packages/tui/src/components.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 6 | `packages/tui/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 5 | `packages/tui/src/views.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 5 | `packages/worker/src/approval-client.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/worker/src/index.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 435 | `packages/worker/src/lane/test-harness.ts` | #401 | keep: test-only faux-lane factory (boots the real `bootSoloLane` over MemoryStorage / temp-dir JSONL) imported exclusively by `*.test.ts` files, which the value-import walk excludes by rule — a test seam can never be `reachable` |
| 4 | `packages/worker/src/session.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 4 | `packages/worker/src/tools.ts` | #102 | delete: reserved `export {};` stub — not a terminal state (criterion 5) |
| 58 | `apps/kubic/src/cli/context.ts` | cli-foundation | keep: type-only registry contract (`CommandContext`, `CommandRegistrar`, `DispatchRunners`) consumed through `import type` by `dispatch.ts`, `cli/program.ts` and every `commands/*.ts` module — a types-only module is never `reachable` by the value-import rule |

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

## Unwired exports of reachable modules

The gate above is file-level: a reachable module can still export dead
functions. Rows here own those exports; `packages/host/src/config/secrets-surface.test.ts`
fails when an export of `packages/host/src/config/secrets.ts` has neither a
non-test caller nor a row below (issue #359).

| Export | Module | Owner | Disposition |
| --- | --- | --- | --- |
| `assertNoPlaintextSecrets` | `packages/host/src/config/secrets.ts` | #359 | keep: persistence guard for §36.3 brokering ([design drift item 22](design-drift.md#item-22--363-tool-credential-brokering-is-not-implemented)) |
| `containsPlaintextSecret` | `packages/host/src/config/secrets.ts` | #359 | keep: used only by `assertNoPlaintextSecrets` |
| `ScopedToken` | `packages/host/src/config/secrets.ts` | #359 | keep: §36.3 broker, not implemented (design drift item 22) |
| `issueScopedToken` | `packages/host/src/config/secrets.ts` | #359 | keep: §36.3 broker, not implemented (design drift item 22) |
| `useScopedToken` | `packages/host/src/config/secrets.ts` | #359 | keep: §36.3 broker, not implemented (design drift item 22) |
| `substituteTokenHost` | `packages/host/src/config/secrets.ts` | #359 | keep: §36.3 host substitution, not implemented (design drift item 22) |
| `revokeAllTokens` | `packages/host/src/config/secrets.ts` | #359 | keep: §36.3 settle/exit revocation, not implemented (design drift item 22) |
| `emptyFileOps` | `packages/worker/src/compaction.ts` | #34 | keep: §27 structured-summary/file-ops vocabulary; the spill path is not implemented |
| `accumulateFileOps` | `packages/worker/src/compaction.ts` | #34 | keep: §27 structured-summary/file-ops vocabulary; the spill path is not implemented |
| `formatStructuredSummary` | `packages/worker/src/compaction.ts` | #34 | keep: §27 structured-summary vocabulary; summaries are not rendered anywhere yet |
| `resolveTruncatedOutput` | `packages/worker/src/compaction.ts` | #34 | keep: spill-path resolver; the spill path is not implemented |
| `buildSpillArtifact` | `packages/worker/src/compaction.ts` | #34 | keep: spill artifact constructor; spill artifacts are not implemented |
| `passThroughOutput` | `packages/worker/src/compaction.ts` | #34 | keep: no-truncation guarantee for the spill path; the spill path is not implemented |
| `assertSingleModelId` | `packages/worker/src/prompts.ts` | #215 | wire: single-model-per-turn guard; no per-turn re-selection site exists yet to gate |
| `SessionCacheStats` | `packages/worker/src/prompts.ts` | #215 | keep: cache hit/miss observability vocabulary; no status surface reads it yet (TUI footer / cost) |
| `buildCompactionRoute` | `packages/worker/src/prompts.ts` | #215 | keep: Rule 7 fresh-routing-id guard; no routing-id compaction site exists yet |
| `compositionOrder` | `packages/worker/src/lane/wrap.ts` | #215 | keep: extension wrap-order formatter; the boot order is fixed, nothing formats it yet |
| `settleSubmission` | `packages/worker/src/lane/settle.ts` | #215 | keep: submission-settlement kernel; the live path settles via `settleTerminalStatus` directly |


# `@kubic/extensions`

> Design ref: bundle facade over library layers; source:
> `packages/extensions/FACETS.md` (quoted, not copied).
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/extensions/src` (read-only — this page quotes it, never moves it).

`@kubic/extensions` ships first-party Kubic features as facet bundles
under `src/bundles/<name>/` (issue #37; §31–§32). v1 is
kernel-internal; the public third-party API lands in Phase 3/4 behind
isolated-vm (§83). v1 loads owned code only — third-party is refused at
`register`/`resolve` time with `ExtensionRefusedError`, and there is no
bypass flag anywhere.

Quoted from `packages/extensions/FACETS.md` — the four facets:

| Facet | File | Owns | May import |
| --- | --- | --- | --- |
| `contract` | `contract.ts` | Service names, narrow types, facades | `contract` only |
| `host` | `host.ts` | Service registration (`provide`) | `contract`, core/agents |
| `worker` | `worker.ts` | Limit checks, lane-side pure logic | `contract`, core/agents |
| `tui` | `tui.ts` | Read-only status text / view models | `contract`, core only |

`index.ts` wires the four facets into one `BundleDefinition`
(`manifest` + `factory`) on the public loader path
(`ExtensionLoader.register` → `activateAll`). Structural rules
(enforced, not advisory): TUI never imports host (`assertFacetImports`
+ `dep-lint` reject any `@kubic/host`/`host/` import from a tui facet);
worker never imports pi-tui; local never remote (local services throw
`ServiceRemoteError` on remote `use`); secrets stay local (full secret
resolves via `getLocal` only; the shared shape is the narrow
`SecretFacade` `{ name, hasValue }`, no value field); replicated state
is snapshot-then-updates with contiguous deltas; disconnect cancels
invocation-only scopes. Loading: jiti from owned paths only
(`~/.pi/agent/extensions`, `.pi/extensions`, owned `kubic/`/`@kubic/`
packages, `-e` allowlist); activation order is sync factory `setup` →
async `onActivate` → `session_start` → `resources` → `provider` flush.
Dogfood: `bundles/budget` delegates to the real `agents`
`createBudget` surface (read-only, never modified) and exposes
`budget/limits` through the loader — the template for
approval/trajectory/eval bundles.

## Public API (`packages/extensions/src`)

| Module | Exports |
| --- | --- |
| `contract.ts` | `FacetKind`, `FACET_KINDS`, `ExtensionManifest`, `ExtensionRefusedError` |
| `facets.ts` | `assertFacetImports`, `FacetBoundaryError` |
| `loader.ts` | `FlushStage`, `FLUSH_ORDER`, `ActivationEnv`, `ActiveHandle`, `BundleFactory`, `ExtensionLoader` |
| `startup.ts` | `BundleDirFiles`, `PostureOptions`, `RefusedAttempt`, `ExtensionPosture`, `BundleLoad`, `BUNDLE_MANIFEST_FILE`, `ExtensionStartupError`, `FIRST_PARTY_BUNDLE_NAME`, `loadFirstPartyBundle`, `probeFirstPartyPosture` |
| `runtime.ts` | `startFirstPartyExtensions`, `EXTENSION_STARTUP_COMMANDS`, `commandLoadsExtensions`, `postureFromStartup`, `budgetStatusOf`, `firstBreachedLimit`, `budgetLimitsOf`, `budgetToolGate`, `ExtensionBudgetError`, `ToolGateContribution` |
| `services.ts` | `ServiceOptions`, `UseOptions`, `ServiceEntry`, `ServiceRemoteError`, `ServiceNotFoundError`, `ServiceRegistry`, `LoaderEnvView`, `createEnv` |
| `cancellation.ts` | `CancellationDomain`, `CANCELLATION_DOMAINS`, `DisconnectController`, `TaskScope` |
| `replicated.ts` | `CellDelta`, `CellSnapshot`, `ReplicatedCell` |
| `secrets.ts` | `SecretFacade`, `SecretRemoteError`, `SecretStore` |
| `trust.ts` | `TrustOptions`, `TrustSubject`, `assertFirstParty`, `FIRST_PARTY_PUBLISHERS`, `isFirstParty`, `isOwnedPath` |
| `bundles/budget/contract.ts` | `BUDGET_SERVICE`, `BudgetLimits`, `BudgetStatus` |
| `bundles/budget/index.ts` | `BUDGET_MANIFEST`, `BudgetBundle`, `createBudgetBundle` |
| `bundles/budget/host.ts` | `BudgetHostEnv`, `registerBudgetService` |
| `bundles/budget/worker.ts` | `BudgetUsage`, `checkBudgetExhausted` |
| `bundles/budget/tui.ts` | `renderBudgetStatus` |
| `index.ts` | Re-exports the surface above |

## Contracts

### Manifest + loader (`contract.ts`, `loader.ts`)

| Interface | Fields |
| --- | --- |
| `ExtensionManifest` | `name: string`, `publisher: string`, `version: string`, `sourcePath?: string`, `facets: FacetKind[]` |
| `ActivationEnv` | `use(name): unknown`, `provide?(name, impl): void`, `flush(stage): void` |
| `ServiceOptions` | `local?: boolean` |
| `UseOptions` | `remote?: boolean` |
| `ServiceEntry` | `name: string`, `impl: unknown`, `opts?: ServiceOptions` |

`FACET_KINDS` is `['contract', 'host', 'worker', 'tui']`;
`FLUSH_ORDER` is `['session_start', 'resources', 'provider']`.
`ExtensionLoader.register` refuses non-first-party manifests before any
import runs; `resolve` validates jiti targets against owned paths;
`activateAll` runs sync factory setup, then async `onActivate`s, then
the flush stages. `ServiceRegistry` provides/consumes via
`provide`/`provideMany`/`use`/`observe`; `use` on a missing service
throws `ServiceNotFoundError`.

### Startup (`startup.ts`, `runtime.ts`; issue #93)

What loads, when: `run`, `tui`, and `orchestrate` load the first-party bundle
set at composition-root boot — the solo lane (`run`, `tui`) and the manager
lane (`orchestrate`) go through the same loader
(`loadFirstPartyBundle`), and `kubic doctor` reports the SAME startup
object's counts (a projection, never a second probe). Commands that read
state rather than boot a lane (`diff`, `undo`, `log`, `status`, `sessions`,
`git`, `models`, `export`, `--version`, …) do not load extensions at all.

The load: the on-disk manifest (`skills/budget/manifest.json`, data — never
executed) is validated, compared to the compiled `BUDGET_MANIFEST` pin
(name+publisher+facets — drift fails closed, even when the trust gates alone
would admit it), gated by `assertFirstParty`, registered on the real
`ExtensionLoader`, activated through the documented path (sync factory setup →
async `onActivate` → `session_start`/`resources`/`provider` flush), and the
`budget/limits` service is provided local-only (v1 has no remote extension
resolution). Both bypass tripwires (owned-path traversal, truthy remote flag)
run live on every load: both refused, both counted. The upward walk for the
bundle dir is capped at 4 levels (both shipped layouts resolve; anything
further is outside the repo), and the ok path requires both tripwires refused
— a structural ok with no refusals fails.

What is refused: anything not first-party (publisher `kubic`/`konic-labs`
with an owned `sourcePath`), any manifest that drifts from the compiled pin,
and any bundle whose load cannot complete. Removal is fail-closed and
lane-specific: a missing/unreadable/tampered `skills/budget` throws
`ExtensionStartupError` on `run`/`tui`/`orchestrate` — the command refuses to
start rather than running bare (`kubic run` maps it to the `failed` terminus
with the named message; the CLI prints `error: …` and exits non-zero) — while
`kubic doctor` reports the same failure as its `FAIL extension:bundle
(extension-posture)` line. An admitted bypass fails the load too: the #37
hardening regressing turns every lane red, not just doctor.

Facet liveness: no declared facet is dead. `contract` and `host` load the
service; the tui facet renders the status text the startup object carries
(`budgetStatusOf`); the worker facet's `checkBudgetExhausted` gates live tool
calls through `budgetToolGate` — the contribution `apps/kubic` composes into
the real solo tool stack, so a `maxToolCalls` budget actually bounds a run
(`firstBreachedLimit` is the same check for a usage reading).

### Budget bundle (`bundles/budget/`)

The dogfood template: `BUDGET_SERVICE` is `'budget/limits'`;
`BUDGET_MANIFEST` is `{ name: 'kubic/budget', publisher: 'kubic',
version: '0.0.0', sourcePath: 'kubic/budget', facets: all four }`;
`createBudgetBundle(limits)` builds the real budget via `createBudget`
(no defaults smuggled) and registers it through `registerBudgetService`.

| Interface | Fields |
| --- | --- |
| `BudgetLimits` | `maxTokens?: number`, `maxCostUsd?: number`, `maxRuntimeMs?: number`, `maxToolCalls?: number` |
| `BudgetStatus` | `configured: boolean`, `limits: BudgetLimits` |
| `BudgetUsage` | `tokens?: number`, `costUsd?: number`, `toolCalls?: number` |

`checkBudgetExhausted(usage, limits)` returns the breached limit name or
`undefined`; `renderBudgetStatus(limits)` renders read-only status text
(`budget: none configured` when empty).

## Dep-direction neighbours

- May import: core, exec, [agents](agents-pkg.md),
  [trajectory](trajectory.md), [eval](eval.md) — never worker/host/tui
  implementation or the app root (`kubic`).
- Facet splits: tui facets import the contract facet only; worker
  facets never import pi-tui (both enforced).

```text
core + exec + agents (+ trajectory, eval) ──→ @kubic/extensions
        (never worker/host/tui implementation, never apps/kubic)
```

Back to the [docs index](../README.md).

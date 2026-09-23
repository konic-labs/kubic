# Extension facet layout (issue #37; §32)

First-party Kubic features ship as facet bundles under
`packages/extensions/src/bundles/<name>/`. v1 is kernel-internal; the
public third-party API lands in Phase 3/4 behind isolated-vm (§83).

## The four facets

| Facet      | File           | Owns                                   | May import              |
| ---------- | -------------- | -------------------------------------- | ----------------------- |
| `contract` | `contract.ts`  | Service names, narrow types, facades   | `contract` only         |
| `host`     | `host.ts`      | Service registration (`provide`)       | `contract`, core/agents |
| `worker`   | `worker.ts`    | Limit checks, lane-side pure logic     | `contract`, core/agents |
| `tui`      | `tui.ts`       | Read-only status text / view models    | `contract`, core only   |

`index.ts` wires the four facets into one `BundleDefinition`
(`manifest` + `factory`) and registers it on the public loader path
(`ExtensionLoader.register` → `activateAll`).

## Structural rules (enforced, not advisory)

1. **TUI never imports host.** `tui.ts` imports the contract facet only.
   `assertFacetImports('tui', …)` and `scripts/dep-lint.mjs` reject any
   `@kubic/host` or `host/` import from a tui facet file.
2. **Worker never imports pi-tui.** `worker.ts` is pure logic; any
   `@earendil-works/pi-tui` import from a worker facet file is rejected.
3. **Local never remote.** Services registered `local:{true}` throw
   `ServiceRemoteError` on `use(name, { remote: true })`.
4. **Secrets stay local.** The full secret resolves via `getLocal` only;
   remote resolution throws `SecretRemoteError`; the shared shape is the
   narrow `SecretFacade` (`{ name, hasValue }`, no value field).
5. **Replicated state is snapshot-then-updates.** Readers snapshot, then
   replay `updatesSince(version)`; deltas are contiguous (`to[i] ===
   from[i+1]`). Disconnect clears readiness and drops buffered deltas.
6. **Disconnect cancels invocation-only.** `DisconnectController`
   aborts `invocation` scopes; `service` and `durable` scopes survive.

## Loading

jiti loads from owned paths only (`~/.pi/agent/extensions`,
`.pi/extensions`, owned `kubic/`/`@kubic/` packages, `-e` allowlist).
Activation order is fixed: sync factory `setup` → async `onActivate` →
`session_start` → `resources` → `provider` flush. Third-party code is
refused at `register`/`resolve` time with `ExtensionRefusedError`; there
is no bypass flag.

## Dogfood

`bundles/budget` is the first Kubic feature on this path: it delegates to
the real `agents` `createBudget` surface (read-only, never modified) and
exposes `budget/limits` through the loader. It is the template for
approval/trajectory/eval bundles.

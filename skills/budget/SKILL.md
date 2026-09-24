# kubic/budget skill bundle

First-party skill bundle (issue #80; publisher `kubic`, v1 ships
first-party bundles only). The budget surface as an extension: limits
(`maxTokens`, `maxCostUsd`, `maxRuntimeMs`, `maxToolCalls`) flow from
the real `agents` `createBudget` surface (read-only, never modified)
through the public loader path, and the worker facet reports the first
breached limit.

## Manifest

[`manifest.json`](manifest.json) is data, never code: at CLI startup
`kubic doctor` reads it, validates it through the `#37` trust gates
(`assertFirstParty` — owned path plus first-party publisher, no
bypass), registers it on the `ExtensionLoader`, and activates the
compiled-in factory. Removing this directory fails closed (`extension
bundle dir missing`), never a silent no-op.

## Facets

| Facet | Owns |
| --- | --- |
| `contract` | `budget/limits` service name, `BudgetLimits`/`BudgetStatus` shapes |
| `host` | Service registration (`provide`, local-only in v1) |
| `worker` | `checkBudgetExhausted(usage, limits)` — breached limit name or `undefined` |
| `tui` | `renderBudgetStatus(limits)` — read-only status text |

Structural rules (enforced, not advisory): the tui facet imports the
contract facet only (never host); the worker facet never imports
pi-tui; local services are never resolvable remotely. See
[`packages/extensions/FACETS.md`](../../packages/extensions/FACETS.md)
and the [`@kubic/extensions` docs](../../docs/packages/extensions.md).

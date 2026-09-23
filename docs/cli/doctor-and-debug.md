# Doctor and debug

> Design ref: `kubic doctor` diagnostics (`packages/host/src/doctor.ts`,
> issue #29; honest-limits registration in
> `packages/host/src/limits/doctor-limits.ts`, issue #58).
> Presentation only: providers are listed, never dialled (faux-only
> probes, zero network); deps check the live node runtime.

## Running it

```
kubic doctor [--skip <id[,id…]>] [--json]
```

Each check prints one human line:

```
PASS provider:local (ok): reachable, 1 model(s) registered
FAIL provider:openai (provider-down): unreachable
doctor: 3 pass, 6 warn, 1 fail, 0 skip
```

`--json` emits `{ok, exitCode, checks}` with the same checks and the
same exit code. Exit contract: 0 clean, 6 provider-down, 1 any other
fail, 2 usage error — full table on the
[exit-codes page](exit-codes.md).

On a fresh clone with no provider configured, doctor exits 6 with
exactly one failure — `FAIL limit:provider-availability (provider-down)` —
and everything else passing (`warn` never flips the exit). Configure a
provider (see [configuration](configuration.md)) for a fully clean matrix.

## What each check means

Statuses: `pass` / `warn` / `fail` / `skip`. Reasons: `ok`,
`provider-down`, `policy-mismatch`, `deps-missing`, `full-access`,
`skipped`. `warn` is informational only — it never flips the exit code.

| Check id | Meaning | Red means → look at |
| --- | --- | --- |
| `provider:<id>` | Is the provider reachable, and how many models are registered? | `reason: provider-down` → configure the provider (see [configuration](configuration.md)); note `kubic run` exits 6 on provider failure. |
| `dep:<id>` | Is the dependency present? (Today: `node`, needs >= 22.19.) | `reason: deps-missing` → install/upgrade the dep; the detail line says what was found. |
| `policy:approvals` | Does the approval policy validate? Unknown `autoApprove` capabilities (outside the known set plus `requires:<tool>` triggers), `autoApprove` entries under `route=deny` (they can never apply), or an outright invalid shape. | Your `[approvals]` config — see [configuration](configuration.md). |
| `license:kubic` | License identity (`MIT`). Always passes; reported, never skipped implicitly (explicit `--skip license:kubic` still works). | Nothing — informational. |
| `policy:enforceability` | Can v1 actually honor the policy? `[mcp]` keys and `mcp:`/`extensions:`/`third-party:` autoApprove values fail here with the refusal. Invalid shapes are **not** double-failed — they point at `policy:approvals`. | Remove the v1-unsupported key (MCP arrives in Phase 4). |
| `limit:provider-availability` | Is at least one provider reachable? | Same as `provider:<id>` — configure a provider. |
| `limit:deps-present` | Are all dep probes present? | Same as `dep:<id>`. |
| `limit:<…>` (six static notices) | Honest §59.1 limits, always `warn`: solo has no isolation, worktrees separate writers only, no injection prevention, policy is an offer not enforcement, journal is not a backup, no third-party MCP. | Nothing to fix — they are disclosures, not failures. If your matrix is all-green except warns, you are healthy (exit 0). |

## Debugging with `--skip`

`--skip` marks checks skipped (comma-separated, e.g.
`--skip license:kubic,limit:solo-no-isolation`) — useful to isolate a
red check from noise. Skipping an id that matches no check exits 2, so
a typo fails closed instead of silently passing.

## Where to look next when something is red

1. **Provider red** → `kubic models` (is anything registered?) →
   `models.json` / provider env keys → [configuration](configuration.md).
2. **Dep red** → `node --version` (need >= 22.19).
3. **Policy red** → your `[approvals]` table → [configuration](configuration.md).
4. **Run fails but doctor is green** → the failure is per-run, not
   environmental: check the `error:` line and the
   [exit code](exit-codes.md), then `kubic sessions attach <id>` and
   the `journal:`/`trajectory:` refs the run printed.

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md) and [commands](commands.md).

# Kubic documentation

Scaffold for the `docs/` tree (issue
[#61](https://github.com/konic-labs/kubic/issues/61), EPIC G
[#60](https://github.com/konic-labs/kubic/issues/60)). Every Kubic feature
gets one home here, separated by area so architecture rationale, package
APIs, and CLI operations never mix. Content pages land in child issues
[#62](https://github.com/konic-labs/kubic/issues/62),
[#63](https://github.com/konic-labs/kubic/issues/63), and
[#64](https://github.com/konic-labs/kubic/issues/64); this index, the
separation rules, and the ownership map are the scaffold those issues
build on.

## Separation of concerns (SoC)

| Area | Directory | Belongs here | Does NOT belong here |
| --- | --- | --- | --- |
| Architecture | [architecture/](architecture/README.md) | Topology and why: solo vs orchestrator, change journal, approvals safety model, package map | API signatures, CLI flags, config keys |
| Packages | [packages/](packages/README.md) | One page per package: public API, contracts, dep-direction neighbours | Architecture rationale, CLI usage |
| CLI & operations | [cli/](cli/README.md) | Commands, flags, exit codes, config precedence, `doctor` diagnostics | Package internals |
| Contributing | [contributing.md](contributing.md) | Workflow (LC0–LC6), Conventional Commits, the docs-update rule | Feature documentation |

## Page index and owners

`stub` pages hold their headings and design refs so links resolve; their
owner issue replaces the stub notice with content.

### Architecture (owner: #62)

| Page | Covers |
| --- | --- |
| [overview.md](architecture/overview.md) | System overview and package map |
| [solo.md](architecture/solo.md) | Solo mode: single trust zone, no isolation (§59.1) |
| [orchestrator.md](architecture/orchestrator.md) | Orchestrator mode: manager + workers + worktrees |
| [journal-and-safety.md](architecture/journal-and-safety.md) | Change journal and approvals safety model |

### Packages (owner: #63)

| Package | Docs page |
| --- | --- |
| `packages/core` | [packages/core.md](packages/core.md) |
| `packages/exec` | [packages/exec.md](packages/exec.md) |
| `packages/worker` | [packages/worker.md](packages/worker.md) |
| `packages/host` | [packages/host.md](packages/host.md) |
| `packages/agents` | [packages/agents-pkg.md](packages/agents-pkg.md) |
| `packages/trajectory` | [packages/trajectory.md](packages/trajectory.md) |
| `packages/eval` | [packages/eval.md](packages/eval.md) |
| `packages/tui` | [packages/tui.md](packages/tui.md) |
| `packages/extensions` | [packages/extensions.md](packages/extensions.md) |
| `apps/kubic` (composition root) | [cli/commands.md](cli/commands.md) |

### CLI & operations (owner: #64)

| Page | Covers |
| --- | --- |
| [commands.md](cli/commands.md) | Every `kubic` command and flag |
| [issue-81-live-smoke.md](smoke/issue-81-live-smoke.md) | Live provider smoke record: settled run + diff + undo + doctor, with gaps |
| [exit-codes.md](cli/exit-codes.md) | Exit-code table (all six codes) |
| [configuration.md](cli/configuration.md) | Config precedence and secrets |
| [doctor-and-debug.md](cli/doctor-and-debug.md) | `kubic doctor` diagnostics and debugging |
| [contributing.md](contributing.md) | Contributor workflow (mirrors `AGENTS.md` LC0–LC6) |
| [design-drift.md](design-drift.md) | Design-vs-shipped reconciliation: what the design says, what the tree does, who owns each gap |

## Standards

1. **One page per area, one area per page.** Architecture pages explain
   why; package pages specify APIs and contracts field-for-field;
   CLI pages specify behaviour operators see. Cross-link instead of
   duplicating.
2. **Docs update in the same commit as the code.** Each implementation
   wave updates its docs page in the same commit — a behaviour change
   without its docs page is incomplete and fails review. See
   [contributing.md](contributing.md).
3. **No broken internal links.** `node scripts/check-docs-links.mjs`
   must pass; it runs in CI via `npm test`. External URLs and
   same-page anchors are exempt.
4. **Honest limits, stated plainly.** Solo mode has no isolation and
   docs must never imply otherwise (design §59.1).
5. **Contracts quoted exactly.** Package pages mirror
   `packages/*/src` type definitions field-for-field; dep-direction
   claims must match `scripts/dep-lint.mjs`.
6. **Stubs stay linked.** A stub page keeps its headings, design refs,
   and back-link to this index so the tree never has dead ends.

## Contributing a docs page (#62–#64 path)

1. Pick up the stub for your area from the index above.
2. Replace the stub notice with content, keeping the page's headings
   and design-ref section.
3. Update this index only if you add or rename a page (content edits
   need no index change).
4. Run `node scripts/check-docs-links.mjs` and the package checks in
   [contributing.md](contributing.md) before committing.
5. Land code and docs together per the same-commit rule.

## Source material (read-only, do not move)

Package-level contracts live with their code and are quoted — not
copied — by package pages: `packages/trajectory/CONTRACT.md`,
`packages/eval/COMMUNITY.md`, `packages/extensions/FACETS.md`.

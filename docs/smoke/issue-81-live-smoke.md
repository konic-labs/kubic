# Live provider smoke — issue #81

First `kubic run` against a real (non-faux) provider, plus `diff`, `undo`,
`doctor`. Scratch-only: nothing outside the scratch dir was touched.

- Date: 2026-09-24. Binary: `bin/kubic.js` on repo build (`npm run build`
  clean at `feat/issue-81-placeholders`).
- Provider: local Ollama at `http://localhost:11434/v1` via `models.json`
  (`openai-completions`, provider id `local`, model `qwen3.5:0.8b` —
  GPU-loaded, tools-capable, zero paid tokens).
- Hermetic env: `HOME=<scratch>/home` (sessions land under
  `<scratch>/home/.kubic/sessions`), `KUBIC_API_KEY=<redacted-dummy>`
  (Ollama ignores it; value was never a real secret).
- Scratch dir itself is untracked cache (not in the repo); `models.json`
  held only the local endpoint above — no secrets.

## 1. Settled run (exit 0)

```console
$ kubic run -p "Reply with exactly: SMOKE-OK. Do not call any tools."
result: SMOK-E-K
session: 01a0d31b-7181-71a1-b5f6-95d3ea318706
journal: journal:01a0d31b-7181-71a1-b5f6-95d3ea318706
usage: usage:01a0d31b-7181-71a1-b5f6-95d3ea318706
trajectory: trajectory:01a0d31b-7181-71a1-b5f6-95d3ea318706
exit: 0
```

Settled `completed` against live inference. The summary text (`SMOK-E-K`)
is the 0.8b model's own garble of the requested echo — recorded verbatim,
not cleaned up. Transcript persisted at
`sessions/01a0d31b-…/…jsonl` (705,341 bytes); session journal dir created
(empty — the model called no tools, so no file effects).

## 2. diff / undo / doctor (all exit 0)

```console
$ kubic diff
no changes
exit: 0

$ kubic undo --dry-run
nothing to undo
exit: 0

$ kubic doctor
loaded models.json: local
PASS provider:local (ok): reachable, 1 model(s) registered
PASS dep:node (ok): node 24.13.0 (need >=22.19)
PASS policy:approvals (ok): route=ask-user, 0 auto-approved
PASS license:kubic (ok): MIT (see LICENSE)
WARN limit:solo-no-isolation (ok): honest limit (not enforced) …
WARN limit:worktrees-writers-only (ok): honest limit (not enforced) …
WARN limit:no-injection-prevention (ok): honest limit (not enforced) …
WARN limit:policy-offer (ok): honest limit (not enforced) …
WARN limit:journal-not-backup (ok): honest limit (not enforced) …
WARN limit:no-third-party-mcp (ok): honest limit (not enforced) …
PASS limit:provider-availability (ok): reachable: local
PASS limit:deps-present (ok): present: node
PASS policy:enforceability (ok): route=ask-user, 0 auto-approved …
doctor: 7 pass, 6 warn, 0 fail, 0 skip
exit: 0
```

(WARN lines abbreviated to their headers; full text is the §59.1 honest
limits, all `warn`-by-design. `doctor` exit 0 with warns is healthy.)

## 3. File-writing run — did NOT settle (honest failure)

```console
$ kubic run -p "Create a file named smoke-note.txt … Then reply DONE."
TIMED OUT after 420 s (no settlement, no `smoke-note.txt` written)
session 01a0d31f-cc94-7089-bbdc-136989fc7b8b created; transcript grew to
500,543 bytes of `thinking_delta` frames — the 0.8b model reasoned about
filenames for 1000+ deltas without ever emitting a tool call or answer.
```

Live provider traffic confirmed (real deltas in the session JSONL), but the
run never settles: `kubic run` has no wall-clock or turn guard (only retry
waits + compaction reserve in `lane/solo.ts`). Filed as gap G2 below.

## Gaps found (none hidden)

- **G1 — `kubic diff`/`undo` cannot see a `kubic run` session journal.**
  The run prints `journal:<id>` but `diff`/`undo` only read
  `<cwd>/.kubic/journal`; run file-effects live under
  `<sessions-root>/<id>/journal/`. A run that writes files still reports
  `no changes` in the cwd. Draft issue below.
- **G2 — `kubic run` has no timeout/turn guard.** §3 above: a model that
  never stops thinking never settles. Draft issue below.

`gh` had no auth in this session, so the drafts below are ready to file
verbatim (repo issue-contract shape); filing them closes the loop.

### Draft: [host] `kubic diff`/`undo` cannot reach a headless-run session journal

```text
## Context

Follow-up to #81 live smoke (journal, exit codes).

## Goal

After `kubic run` prints `journal:<id>`, an operator can diff/undo that
run's file effects from the CLI.

## Scope

In: a documented path from the printed ref to the effects (flag, subcommand,
or `diff` fallback that resolves `journal:<id>` under the sessions root).
Out: changing where the headless lane records effects.

## Acceptance criteria

- [ ] `kubic run` (file-writing prompt) → `kubic diff` shows the run's
      effects from the cwd with no extra lookup.
- [ ] `kubic undo --dry-run` plans against the same store `diff` reads.
- [ ] Docs (`docs/cli/commands.md`) state which store each command reads.

## Dependencies

- Needs the sessions-root layout owned by #14/#28.
```

### Draft: [host] `kubic run` needs a wall-clock / turn guard

```text
## Context

Follow-up to #81 live smoke (exit codes, solo lane #11).

## Goal

`kubic run -p` always settles (or fails closed) within a bounded time,
even when the model never stops thinking.

## Scope

In: a `--timeout`-style bound and/or max-turn guard on the headless drive
loop mapping to a §78 terminus (failed/budget), documented in
`docs/cli/commands.md` + `exit-codes.md`. Out: changing model thinking
behaviour.

## Acceptance criteria

- [ ] A never-settling model terminates within the bound with a non-zero
      §78 exit and a `journal:`/`usage:`/`trajectory:` ref triple intact.
- [ ] Default bound documented; override flag documented.
- [ ] Faux-driven contract test pins the mapping (no network).

## Dependencies

- Independent of G1; touches `run-cli.ts` + `headless-run.ts` only.
```

## Secret sweep

`grep` over the tree (excluding `pi/`, `node_modules`, `dist`) for
`sk-`, `api[_-]?key\s*[:=]`, `ghp_`, `AKIA`, `BEGIN .*PRIVATE KEY`,
`xoxb-`: no live secret material. Committed tests use faux fixtures only.
(`KUBIC_API_KEY` appears in code/tests as an env-var *name* and in
`models.json` docs as `$ENV_VAR` refs — never a value.)

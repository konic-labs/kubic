# Analysis commands

> `kubic cost`, `eval`, `benchmark`, `replay`, `export`, `policy` and `audit`:
> reading what runs did. Back to the [command index](commands.md).

## Analysis commands: shared rules

`eval`, `benchmark`, `replay`, `export`, `cost`, `policy` and `audit` are
parsed by commander
(`apps/kubic/src/commands/analysis.ts`, see
[contributing-cli.md](../contributing-cli.md)). They share these rules:

- **Help.** `kubic <command> --help` (or `-h`) prints generated help on
  stdout and exits 0. The help lists every option with its argument and
  meaning, followed by an `Examples:` block.
- **Argv syntax.** Both `--flag value` and `--flag=value` work, and `--`
  ends the options. An unknown option, an option missing its value, a
  missing required option, or an extra operand prints one
  `error: …` line on **stderr** (for example
  `error: unknown option '--bogus'` or
  `error: required option '--tool <name>' not specified`) and exits
  **2**. The command itself never runs.
- **stdout is data, stderr is diagnostics.** Reports, tables and JSON go
  to stdout. Refusals and warnings go to stderr, one `<level>: <message>`
  line each. A refusal is `error: <message>`, or
  `error: [<code>] <message>` when it has a code.
- **Tables.** `cost`, `audit` and `benchmark` print their rows as
  a table. On a colour terminal the table is the kit table (muted header, faint rule) with coloured
  headers. On a pipe, in CI, or with `NO_COLOR`, it is plain
  space-aligned columns.
- **`--json`.** stdout carries exactly one JSON document and nothing
  else, with no colour and no tables. Every document is indented with
  two spaces (the eval, benchmark, replay and export envelopes were
  single-line before the commander migration). `eval`, `benchmark`, `replay` and
  `export` put runtime failures inside their envelope. A bad invocation,
  which is a usage error, leaves stdout empty and prints its `error:`
  line on stderr.

## `kubic eval --suite <id> (--task <prompt> | --trajectory <file>) [--worktree <path>] [--size <size>] [--model <id>] [--workspace inline|worktree] [--thinking <level>] [--json]`

Scores one suite against a task prompt or an existing trajectory
export. Every record needs its provenance (`model`, `thinking`,
`worktree`) and a `--size`; a record missing any of them is refused with
exit 2 and is never stored. A suite is one case: a record's `caseId` is the
suite name.

- With `--task`, the provenance comes from the flags: `--worktree` is
  mandatory and `--model` defaults to `faux/echo`
  (the shipped testing provider's registered model).
- With `--trajectory`, the provenance comes from the export itself:
  `model` from `provenance.model`, `thinking` from `model.thinking`, and
  `worktree` from `provenance`. These flags become
  optional cross-checks. A flag that disagrees with the export is
  refused with exit 2 and `[provenance-mismatch]`, and no record is
  printed. The size is not part of an export, so `--size` stays
  mandatory; the determinism tier is derived from the path.

Exports at schema 1.0 through 1.3 parse, for `replay`, `eval` and `export`
alike. Keys the 1.0 contract does not define are carried through unread, and an escalation recorded without its model
endpoints reads them as `null`.

Every record carries `suite`, `caseId`, `success`, `costUsd`, `tokens`,
`latencyMs`, `toolCalls`, `model`, `thinking`, `worktree`, `size` and
`determinism`. `determinism` is the tier,
derived from the path: `--trajectory` scores a recorded export without
re-executing anything → `recorded`; `--task` executes a model-backed
suite → `live`. Benchmark rows publish the same field (`live` — including
a skipped stub, which names the tier it would run at).

| Flag | Meaning |
| --- | --- |
| `--suite <id>` | **Required.** A built-in suite id — `swe-bench-mini`, `repo-mod-rename`, `bugfix-repro`, `refactor-extract`, `testgen-cover`, `review-diff` or `agentic-live` — or a **category alias** (`swe`, `repo-mod`, `bugfix`, `refactor`, `testgen`, `review`, `agentic`); `kubic eval` scores one record, so a category with more than one suite exits 2 (`ambiguous-suite`). `terminal-live` is a stub and refuses with exit 2. An unknown selector exits 2. |
| `--task <prompt>` | Runs the suite's fixture through the real lane and scores the trajectory it writes: the fixture's prompt is the run, its gate command(s) decide the verdict, and the record carries the eval fields. Needs a reachable model (`--model`, default `faux/echo`) and `--worktree`; the suite's fixture is materialized in a temp directory (or a fresh checkout, with `--workspace worktree`). |
| `--trajectory <file>` | Scores an existing trajectory export file, without re-running anything: the same file form `replay` and `export` take. `-` reads the export from stdin; a value starting with `{`/`[` is the pre inline-JSON form and still works. Fully live: exits 0 with the record, or 1 when the gates fail it. An unreadable file exits 2 (`trajectory-unreadable`), a file that is not JSON or not a valid export exits 2 (`trajectory-malformed`). |
| `--worktree <path>` | The worktree the run executes in (`--workspace worktree` needs it clean). With `--task`, a record without it is refused with exit 2. With `--trajectory` it is read from `provenance.worktree`; a different value exits 2 (`provenance-mismatch`). |
| `--size <smoke\|standard\|extended>` | The record's size class (how much was run) — an implementation-side label, not a tier. Published on every record; a missing or unknown size exits 2 on both paths. |
| `--model <id>` | `provider/id` of the run. With `--task` it defaults to `faux/echo`. With `--trajectory` it is read from `provenance.model`, and a different value exits 2 (`provenance-mismatch`). |
| `--workspace inline\|worktree` | `inline` (default) materializes the suite fixture in a temp directory. `worktree` refuses with exit 2 unless `git status --porcelain` in `--worktree` is clean, then runs each suite in a fresh detached checkout of that repo at its HEAD (`git worktree add --detach`), removed and pruned afterwards. Any other value exits 2. |
| `--thinking <level>` | With `--task`, recorded on the record verbatim (default none). With `--trajectory` it is read from `model.thinking`, and a different value exits 2 (`provenance-mismatch`). |
| `--json` | Prints one JSON envelope (`ok`, `exitCode`, and either `record` or `error`) instead of the text line. The exit code is the same either way. |

Text mode prints one `eval ok: suite …` line on stdout. A refusal prints
`error: [<code>] <message>` on stderr.

## `kubic benchmark [--suite <id>] [--worktree <path>] [--size <size>] [--model <id>] [--workspace inline|worktree] [--thinking <level>] [--json]`

Runs the reproducible matrix: every suite, or a single one with
`--suite`. The output is a `SUITE / CATEGORY / STATUS` table followed by
the verdict line: `benchmark ok|FAILED: <passed>/<executed> suites passed,
<n> stub(s) skipped`.

Stub suites show as `skipped (stub)` with `success:false`, so they are
never reported as passing work, and they never count toward the verdict.
Provenance (`--size`, `--worktree`) is validated once
before the matrix, so even a stub-only selection cannot skip it. A matrix
with **no executable suite** (only stubs selected) refuses with
`error: [no-executable-suites] benchmark: no executable suites selected`
and exit 2 — it never reports `benchmark ok` over zero evidence. The exit
code is:

- 0 if every executed suite succeeded
- 1 if any executed suite failed
- 2 on usage errors: an unknown suite, missing provenance, a dirty
  `--workspace worktree`, a stub-only selection
  (`no-executable-suites`), or a stub suite (the live-PTY
  `terminal-live`, `stub-suite`)

The flags are the same as `kubic eval` without `--task` and
`--trajectory`; each matrix row runs `benchmark:<suite-id>` as its task.
`--json` prints `{ok, exitCode, results}`.

## `kubic replay ([--] <trajectory.json> | --session <id>) [--tier recorded|deterministic|live] [--model <provider/id>] [--lockfile <path>] [--role-config <path>] [--worktree <path>] [--diff-against <other.json>] [--json]`

Replays a versioned trajectory at a declared determinism tier. The tier
is printed, and it is present in `--json` for every result. A tier never
silently downgrades: a tier that needs pins refuses with exit 2 when
they are missing.

`--session <id>` replays that session's own trajectory
(`<sessions-root>/<id>/trajectory.json`, written when a `kubic run` or
TUI turn settles). Giving both a file and `--session`, or a path-unsafe
id, exits 2 with one `error:` line.

| Invocation | Meaning |
| --- | --- |
| `kubic replay traj.json` | Recorded exact: log-only, never re-executes. Exits 0 and prints the tier. |
| `... --tier deterministic --model <provider/id> --lockfile <file>` | Re-executes the recorded objective through the lane at the pinned model. Refuses with exit 2 unless both pins are given. A pin that is not registered exits 6 (`provider_probe_failed`); a model the lockfile does not pin refuses with `lockfile-mismatch` (exit 2). |
| `... --tier live --role-config <file>` | Re-executes at the recorded model under the pinned role config — a JSON file `{"role": "<name>"}`. The role document `.kubic/roles/<name>.md` is loaded from the pinned worktree, so its tools and prompt apply. Refuses with exit 2 without the role config. `--model` and `--lockfile` are refused under live. |
| `... --diff-against other.json` | Recorded compare: names the variables that changed (`model`, `worktree`, `diff`). Any difference exits 1 as the regression signal; identical trajectories exit 0. |

- **Worktree pin.** The re-execution lane is rooted at the pinned
  worktree — the `--worktree` override, or the trajectory's recorded
  `worktree.path` when that path exists on this machine — so the lane's
  tools, journal, role document and project `models.json` resolve there.
  A recorded worktree absent on this machine falls back to the working
  directory; `--worktree` is existence-checked before the run, so an
  explicit override never falls back silently.
- **Lockfile pins.** `--lockfile <file>` is JSON:

  ```json
  {
    "models": { "provider/id": { "digest": "sha256:…" } },
    "prompt": { "digest": "sha256:<hex>" },
    "tools":  { "digest": "sha256:<hex>" }
  }
  ```

  `models` may also key a provider to its pinned ids
  (`{ "provider": ["id", …] }`). The requested `--model` must be pinned
  there, or the run refuses with `lockfile-mismatch` (exit 2) — an
  unpinned model is never silently re-executed. The optional `prompt` and
  `tools` digests are verified against the trajectory being replayed (its
  objective text, and the sorted distinct tools its actions used); a
  mismatch is the same named refusal, and a malformed pin is
  `lockfile-invalid` (exit 2).
- **Experimental worktree.** `--worktree <path>` is an experimental
  override for the re-execution tiers. In text mode it prints
  `warn: --worktree is experimental` on stderr; in `--json` it adds
  `experimental:["worktree"]`.
- **Recorded takes the trajectory alone.** Recorded with any of
  `--model`, `--lockfile`, `--role-config` or `--worktree` exits 2.
- **Errors.** A missing trajectory or an unknown `--tier` is a refusal:
  - with `--json`, a tiered envelope (`missing-trajectory` or
    `invalid-tier`)
  - without it, an `error: [<code>] …` line on stderr
- **Exit codes** are the subset 0/1/2/5/6 (see
  [exit codes](exit-codes.md)).

The re-execution tiers read the effective config the same way
`kubic run` does: the configured permission classes and journal
retention govern the re-executed lane, and so does the enterprise
`[policy]` — a re-execution model outside `allowed_models`/
`allowed_providers` exits 6 with the named policy refusal before any
provider call, and the re-executed lane's tools are the same allow/deny
intersection. A refused config exits 1 with the config's named reason
instead of running on defaults.

The refusal check applies to the whole command, not to individual tiers.
A refused config also blocks the log-only tiers (`recorded` and
`compare`): the command exits 1 before any tier runs, so the config has
to be fixed first.

## `kubic export (--trajectory <file> | --session <id> | --dataset <dir|glob>) [--type sft|dpo|grpo|preference|tooluse|coding] [--against <other.json>] [--out <file.jsonl>] [--json]`

Inspects trajectory export files and exports RL dataset records from
them. `--session <id>` stands for `--trajectory
<sessions-root>/<id>/trajectory.json`, the file a settled `kubic run` or
TUI turn writes. Giving both, or a path-unsafe id, exits 2 with one
`error:` line.

- **Without `--type`**, the file is validated and described: schema,
  task, model, provenance, result and usage.
- **With `--type`**, a dataset record is built and validated:
  - `sft`, `tooluse` and `coding` read `--trajectory` alone
  - `dpo` and `preference` (chosen plus rejected) and `grpo` (a
    two-candidate group) also need `--against`

These invocations exit 2 with an `error:` line on stderr, and no file is
read:

- a missing `--trajectory` (and no `--session`)
- an unknown `--type`
- a pair or group type without `--against`
- `--against` on any other type

A pair ranks two answers to one prompt. A pair is excluded when:

- the two files answer a different prompt text or task id
  (`prompt-mismatch-excluded`, checked first)
- either side is an env failure (`env-failure-excluded`)
- the verifier does not prefer chosen over rejected
  (`no-preference-signal-excluded`)
- the runs cross a worktree or task-role boundary (`cross-boundary-excluded`)

An excluded pair prints `excluded: <tag> — <reason>` and exits 0; it
never produces a training record. A DPO record carries both sides'
`taskRef` and `roleRef`, and a hand-built record whose task refs differ fails
validation. `grpo` refuses with exit 2 when its candidates answer
different prompts or tasks. Stripped provenance or failure labels also
refuse with exit 2.

Every record is redacted before it is written, in single-file and batch
mode alike: provider key shapes, PEM blocks, URL userinfo
(`postgres://[REDACTED]@db:5432`), authorization values and the values of
secret-named assignments (`password: [REDACTED]`) — a dataset leaves the
machine, so the redaction over-redacts on purpose (a code sample's
`password: string` field is redacted too).

Text mode prints the canonical record JSON. `--json` wraps it in
`{ok, exitCode, type, record}`, or `{…, excluded}` for an excluded pair.
Failures are envelopes under `--json` and `error: [<code>] …` lines
otherwise. The exit code is:

- 0 when the record was exported or the file described
- 1 when the record failed to build or validate
- 2 on a usage error or refusal

### Batch mode: `--dataset <dir|glob> --type <t> --out <file.jsonl>`

One directory (every `.json` it holds) or a basename glob (`traj/*.json`)
of trajectory exports in, one JSONL of dataset records out, plus a
manifest beside it (`<out>.manifest.json`). `--dataset` needs both
`--type` and `--out`, and refuses `--trajectory`/`--against` (those
belong to single-file mode).

Pairing and grouping are automatic, and the same eligibility policy the
single-file builders enforce applies:

- `dpo` and `preference`: every pass×fail combination within one task id
  *and* prompt — env failures, cross-boundary runs, missing preference
  signals and prompt/task mismatches are excluded, never emitted.
- `grpo`: one group per task id + prompt holding **every** candidate
  (not capped at two).
- `sft`, `tooluse`, `coding`: one record per trajectory.

Files are read one at a time and each record is appended as it is built,
so memory is bounded by one task group, not the dataset size. The output
order is deterministic (sorted files, sorted groups).

The manifest carries the schema version (`dataset/1`), the input count,
the record count, exclusions **by tag** (`env-failure-excluded`,
`cross-boundary-excluded`, `no-preference-signal-excluded`,
`prompt-mismatch-excluded`, `no-counterpart-excluded`,
`singleton-excluded`) with a file/tag/reason row each, and a provenance
summary (distinct sessions, worktrees and models). Text mode
prints one `dataset: …` summary line; `--json` wraps the manifest in
`{ok, exitCode, type, dataset, out, manifest}`.

Exit codes: 0 exported; 1 a matched trajectory failed to parse or build
(`dataset-invalid`, the file is named), or the JSONL/manifest could not be
written (`export-failed`); 2 a usage error or an empty match
(`dataset-empty`). The JSONL is truncated before the first record and the
manifest is written last, so a failed batch leaves a partial JSONL and no
`<out>.manifest.json` — the missing manifest is the completeness marker.

## `kubic cost [--session <id>] [--all] [--by <level>] [--json]`

Reads real usage out of the durable session store, scoped to the current
project by default: only sessions touching the invoking workspace are
reported, with `--all` for the machine-global total the command prints. The unit is the session: rows aggregate to the `--by` level
(`request | session | project`, default `session`), one `GROUP / MODEL / IN
/ OUT / CACHE-R / CACHE-W / COST` row each — a session that ran more than one
model reads as one row per model, with input, output and prefix-cache
counters split out — followed by
`task total $<sum> (<n> <level>)`. The total is exactly the sum of the
rows. Costs below $1 print at 4 decimals (`$0.0023`), $1 and above at 2.

The numbers are the sessions' `pi.usage` documents, so they match what
`Harness.usage()` reports for the same run. Reading is read-only and never
boots a lane. `--by request` lists one row per assistant entry that
carries its response's usage (the model spend of that request — tools that
report their own spend aggregate at the higher levels); `--by project`
rolls each workspace to a single row. A session whose storage a live run
owns is skipped, never opened (pi-durable: one process per storage), and
reported as a zero row with `MODEL` `(locked)`; a session that cannot be
read at all (a half-written directory) is `(unreadable)` the same way. A session that goes live *during* the read —
after the lock probe said it was dead — is read as far as it can be (a
partial trailing record is the writer's uncommitted tail and is skipped,
never a parse error) and gets a zero `(live)` row beside its rows: the
sibling rows may be partial. A session the operator NAMED with `--session`
is never skipped that way: an unknown id and a live lock each print their
refusal and exit 1. The read path is lock-free: `kubic cost` never
creates or removes `lock.json`, so session dir mtimes (the prune age
signal) are untouched and a concurrent attach is never blocked.

When the sessions carry prefix-cache counters, the readout adds the
cache line and the transparent-caching note. With no sessions stored it
prints `no cost rows` and exits 0.

| Flag | Meaning |
| --- | --- |
| `--session <id>` | Reads only this session. Ids follow the same `[A-Za-z0-9_-]` rule as `run`: anything else exits 2 before the store is touched, and an unknown session exits 1 (`error: unknown session: <id>`). An explicitly named session ignores the project scope. |
| `--all` | Lifts the default project scope: report sessions from every project on the machine. |
| `--by <level>` | Group rows at `request`, `session` (the default) or `project`. Anything else exits 2. |
| `--json` | Prints the in-code `toCostJson` shape (`rows`, `taskTotal`) field-for-field — rows carry the same `session`/`project`/`request` identity the table groups on. Exits 0. Kubic has no published JSON contract yet. |

## `kubic policy --tool <name> [--json]`

Answers a policy query as a routing offer, never as enforcement. It
prints `allow <tool>` or `deny <tool>` for the tool policy that a run
from this directory actually installs: the same permission classes, from
the same config load, that `kubic run` enforces and that `kubic doctor`
reports on its `policy:installed` line.

Policy is deny-by-default: a tool outside the installed allowlist is
denied. Tool names match regardless of case and surrounding whitespace.

Unsupported levels are named, never silent: for each
installed permission level the tool set cannot express (network or
credentials `allowlist`, filesystem or git `full`) the command writes one
`warn: <class> '<level>' is unsupported — enforced as '<level>': <reason>`
line to stderr. `kubic doctor` names the same set on its
`policy:installed` line, which is then `WARN (unsupported-level)`.

| Flag | Meaning |
| --- | --- |
| `--tool <name>` | **Required.** The tool to query. A missing or whitespace-only name exits 2. |
| `--json` | Prints `{"tool", "decision"}` instead of the text line, plus `unsupported` (`[{class, level, enforcedAs, reason}]`) when any installed level is unsupported. Exits 0. |

## `kubic audit [--posture <p>] [--result <r>] [--session <id>] [--json]`

Queries the audit trail, matching each supplied filter exactly. `--session`
reads one session's rows (`agent.session` is the session).

**Output.** Text mode prints a table with the columns `WHEN`, `POSTURE`,
`RESULT`, `WHAT`, `PERMISSION`, `APPROVAL` and `REASON`. With no matching
records it prints `no audit records` and exits 0. `--json` prints the full
records: the 13 fields plus `version`, which is `1`. A ledger that exists but
cannot be read (permission denied, I/O error) is not an empty trail: the
command prints `error: cannot read the audit ledger <path>: …` on stderr and
exits 1. Only a missing ledger reads as empty. A ledger line that is a record
of another version, or has no `version`, makes the whole ledger unreadable
with the same error (`line <n> is not a version 1 audit record`); the ledger
is not converted or rewritten, so move it aside to start a new trail. A run
whose ledger is unreadable still writes its `trajectory.json`, with no
approvals in it, after naming the ledger on its warning channel.

**Redaction.** Every record is redacted before it is printed:
secret-shaped values and listed-secret inventory values become
`[redacted-secret]`, so credentials only ever appear as sentinels.

**Where records come from.** There is one ledger per repository,
`<repo>/.kubic/audit/audit.jsonl`, one record per line. `<repo>` is the
main checkout: from a subdirectory or from a linked worktree, every writer
and `kubic audit` resolve the same file (the parent of git's common dir;
outside git, the current directory). The shipped runtime ignore rules cover
this file. Each record is appended and fsynced; a new ledger is created
`0600` in a `0700` directory, and `kubic doctor`'s `state:permissions`
check names a looser one.

- `kubic run` and `kubic tui` append one record per resolved approval ask,
  approved or denied, with `posture` `approvals` or `full-access`. An
  untriggered call raises no ask and writes nothing; a call full access
  waives is recorded once per capability it raised
  (`trigger:<capability>`, posture `full-access`), so the trail names what
  ran unapproved instead of one opaque `trigger:full-access` row per tool
  call. A run from `<repo>/sub` writes the repo ledger, never
  `<repo>/sub/.kubic/`.
- The model on every record is the model the lane runs: `kubic run` reads
  it after the stored-model rule (`--session` without a pin keeps the
  session's own model, and both the record and `trajectory.json` say so).
  `model.thinking` is the thinking level the lane runs, read from the
  conversation's agent document (a `/thinking` change mid-session is read
  at record time, so later rows name the new level).
- `process.pid` names the process that made the decision.
- `workspace.base` is the base revision the run started from: `HEAD` at
  run start, `none` outside git. A row that genuinely knows no better keeps
  the honest `unknown` instead of inventing a value.
- Enabling full access (`--dangerously-skip-approvals` on `kubic`, `tui`,
  `run` or `sessions create`, or the in-session `Alt+A` / `/approvals off`)
  appends one `posture:full-access` row naming the session and the
  command; turning approvals back on (`Alt+A` again, or `/approvals on`) appends
  one `posture:approvals` row, so the ledger carries the posture history in
  order. A flip that would change nothing (the direction is already in
  force) is reported on the footer and writes no row. A `posture.json`
  change made during a session by anything else is refused and recorded
  once as `posture:changed-mid-session`.
- A failed ledger write never changes the decision.

| Flag | Meaning |
| --- | --- |
| `--posture <name>` | Filters on posture. |
| `--result <ok\|deny\|error>` | Filters on result. Any other value exits 2. |
| `--session <id>` | Filters on one session's rows. A whitespace-only value exits 2. |
| `--json` | Prints the matching records as a JSON array, with the same redaction. Exits 0. |

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md), [configuration](configuration.md), and
[doctor and debug](doctor-and-debug.md).

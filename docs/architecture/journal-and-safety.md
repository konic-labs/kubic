# Change journal and safety

Kubic's safety model has two halves: a VCS-independent change journal
that makes every edit reviewable and reversible, and an approvals
model where the user — never the model — decides what dangerous
operations may proceed.

## Change journal

The journal records every file edit the agent makes, whether or not
the directory is a git repository — `kubic diff` and `kubic undo`
work anywhere. Entries are append-only and persist across sessions,
so undo works after the terminal closes. Durability is claimed exactly
where it is implemented: an entry's content is flushed before the index
line that records it — a blob's bytes are fsynced before its rename and
its directory after it — and the index line itself is fsynced before
`append` returns (the price of "reversible" is a few fsyncs per tool
write; the store's `durable` knob, default `true`, trades all of it for a
crash window of one truncated last line). An append also repairs a torn tail:
one pread decides whether the index's last byte is a newline, a fragment
gets one before the new entry — so the entry lands on a line of its own
and is never glued to the fragment and dropped with it — and a failed
append truncates the partial write back to the pre-append length. Dropped
fragments are named as `corrupt index lines` in `kubic status` and removed
by the next retention rewrite that drops an entry — a pass under the bound
takes the fast path and rewrites nothing, so the count can stand for a while. Private state: the journal directory and `blobs/` are created
0700, the index and every blob 0600 — a blob is a copy of file content,
including 0600 sources like `.env`, and the index names every path of the run.
An existing group- or world-accessible state directory (the sessions root, a
journal directory) is tightened to 0700 when the next lock is taken, and
`kubic doctor`'s `state:permissions` check names it while it stays loose. The
undo restore keeps the target file's own mode — Kubic never widens a file it
writes back.

Cross-process coordination: every
journal mutation — append, retention rewrite, blob sweep — runs under an
O_EXCL lock beside the index (stale after ten seconds, so a crashed holder
never wedges the journal), the rewrite abandons itself when the index changed
under it, and the sweep only removes blobs that are unambiguously dead (never
a `${hash}.${pid}.tmp` another process is renaming into place, never one newer
than the pass). Commands that only read step aside for a live run instead of
racing it: `kubic log`'s read-time self-heal skips the pass, with a notice,
while the session lock is live, and `kubic undo` refuses by name (exit 1) unless `--force`. A blob found under the wrong bytes (the
zero-length crash shape) is rewritten from the content in hand instead of
being reused, and the retention compaction rewrite is flushed the same
way — a crash right after it could otherwise replace the whole history
with an empty file. Everything else is atomicity, not fsync: undo restores
are written tmp+rename in the target's own directory, so a crash never
leaves a half-written file visible under its real name, but their bytes are
not fsynced before the rename. Directory-entry durability of the *first*
creation of a file is out of scope — rename durability is what the journal
claims, and `durable: false` opts out of all of it. Turn attribution: every entry may carry the interactive turn
it belongs to. Reconciliation sweep entries carry the turn they swept;
tool-journaled entries (write/edit interception) carry the turn in flight
when the call ran — sampled per call from the TUI's live counter, so both
share one numbering. Headless runs (`kubic run`) are turn-less by design:
pi-durable exposes no numeric turn, so their entries carry no `turn`
field at all — never null, never zero — as do entries written before the
field existed. Undo is part of the record, not
an exit from it: every successful `kubic undo` appends its own inverse
entry (source `undo`, the pre-undo content as its before, the
restored content as its after), so `diff` and `log` describe the world
after the undo. `kubic undo --step` is the redo of an edit-shaped undo;
plain `kubic undo` ignores the `kubic-undo` records entirely, so
repeating it restores real work once, then reports `already undone` and
writes nothing. A delete-shaped undo — the file was absent before it —
records no before-content, so it is reported non-reversible and cannot
itself be undone. Review the record, revert a step or a path, check
status and history; entries the
journal cannot reconstruct (recorded hash, no retrievable pre-image)
are reported as non-reversible rather than guessed at. In a git repository
the sweep can reconstruct more: at baseline it records the index blob OID
of every tracked file clean against the index (two metadata calls, no blob
reads), and at sweep it reads the pre-image of a changed or deleted tracked
file back from the object store — so a bash `rm`, `sed -i`, formatter or
`git checkout -- .` on a committed file undoes exactly like a tool edit.
Only clean files qualify (restoring a committed version over uncommitted
work would destroy it), and the pre-image must hash to the baseline digest
— a mismatch, a binary file, or a pre-image above 4 MiB keeps the hash-only
shape. Untracked files and non-repositories are unchanged. Changes the sweep
captures are bounded the same way: a changed file above 4 MiB — or one whose
utf-8 decode would be lossy (binary content) — is recorded hash-only
(`changed, N bytes`; `diff` shows a size-only line), never as a mangled or
unbounded blob. A HEAD move mid-run is marked, not silently absorbed: the baseline also records HEAD sha, branch and stash count
(three metadata calls), and a sweep that finds them changed appends one
`marker` entry (`head-moved <branch>@<sha> -> <branch>@<sha>`) instead of
letting a `checkout`/`reset`/`stash` read as hundreds of ordinary file
changes. `kubic status` warns per move, `kubic log` lists the marker, and
`kubic undo` refuses to restore entries from before the move without
`--force` — their pre-move content does not belong on the moved HEAD —
while entries journaled after the move restore normally. Retention
bounds keep growth finite: a size cap — the whole store, index plus blobs,
configurable as `[journal] maxBytes` — is enforced on every append, with
opt-in age pruning. An entry whose own content cannot fit the cap is
refused before anything is written — the tool call fails as `journal_failed`
and the file is untouched, rather than landing a record the same append's
pruning would delete — and pruning itself stops at the newest entry: the
record of the change just made is never the thing that gets dropped, so a
single entry over the bound is kept (the store stays over its bound by that
entry) instead of taking the session's history with it.

## Approvals

Dangerous capabilities — network, credentials, privilege escalation,
destructive shell, installs, deploys, pushes, writes outside the workspace
— route to the user first (ask-user by default) or to deny. The rules are fail-closed:

- The decider is the user. There is no model self-approval,
  structurally, not by flag.
- Every ask is time-bounded and denies on timeout; headless runs can
  never hang on an open question.
- The first answer wins; only settled decisions persist, never open
  questions — a crash while an ask is pending re-raises the ask on
  resume rather than resuming the call unapproved, and a settled
  session decision is reused instead of asked again.
- Decisions are session-scoped unless the host explicitly wires a
  shared store.
- An approval's guard stand-down is scoped to exactly the approved call —
  its tool-call id AND its arguments — and is spent once that call has run.
  The id comes from the provider, so a server that repeats `call_0` or
  sends an empty id cannot widen one approval into a standing bypass of the
  destructive/network guards or of path confinement.
- The session's state files are corrupt-tolerant: an `approvals.json` or
  `posture.json` that is unreadable or parses to the wrong shape (`null`,
  an array, a string) falls back to the safe default — no decisions,
  approvals enforced — and a malformed individual decision entry is
  dropped rather than erasing the valid ones beside it.

### Kubic's own control plane

The model never decides its own permissions, so it cannot rewrite the files
that decide them:

- **`kubic-state-write` always asks.** A `write`/`edit` path, a bash
  redirect (`>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `N>`, every one in the
  command), a `tee` target or a `cp`/`mv`/`install` destination — or an
  `rm`/`mv` operand — under `<workspace>/.kubic/` — `config.toml`,
  `roles/`, anything else there — raises the named `kubic-state-write`
  capability. The bash path is read the way the shell reads it, and BOTH the
  path as typed and its resolution against the directory a preceding
  `cd`/`pushd` left behind are checked — either being control-plane counts, so
  a subshell, conditional or quoted `cd` (`(cd x); echo p >
  .kubic/journal/y`) can never hide a write (`cd .kubic/roles && echo x > r.md`
  is caught by the second candidate). Inner quotes and backslash escapes are
  removed (`".kubic"/roles/r.md`), `$HOME/`, `${HOME}/` and `${HOME:-…}/` expand
  like `~/`, `$PWD`/`~+` are the current directory, and a glob or brace list that
  could expand into `.kubic/journal`, `config.toml`, `roles/`, `audit/`
  or `sessions/` is refused. So does a target outside the workspace that
  lands in any ancestor's `.kubic/` or in `~/.kubic/` (the global
  `config.toml`): a run from a subdirectory still guards the project
  root's `.kubic/`. A leading `~/`, `$HOME/` or `${HOME}/` is
  read as the home directory. No `autoApprove` entry answers it (naming it
  there is accepted but ignored: it takes the normal ask path and
  `kubic doctor` warns by name), and neither does the
  session's `--full-access` posture: on a TTY it
  is a dialog, headless it is denied by name (exit 4). The path check is
  case-folded (`.KUBIC/Config.toml` is the config file on a case-insensitive
  disk).
- **Journal, audit and session state are refused outright.** A write —
  or an `rm`/`mv` of it — into `.kubic/journal/`, `.kubic/audit/` (the
  audit ledger) or `.kubic/sessions/` — the workspace's, an ancestor's or
  `~/.kubic`'s — or into the session root the run actually uses
  (`~/.kubic/sessions` by default) is a tool error
  (`refused: … is Kubic control-plane state`), never an ask, whatever the
  posture. The refusal itself is appended to the audit ledger.
- The journal still skips `.kubic/`, so an approved `kubic-state-write` is not
  reversible with `kubic undo` — which is why it is never auto-approved.
- **`.git/` writes always ask.** A planted `.git/hooks/*` file or a
  `core.hooksPath` set in `.git/config` runs code on the user's next git
  command, and the journal never sees it (its sweep skips `.git/`). Any
  write tool call or bash redirect/tee/cp target under the workspace's own
  `.git/` or any ancestor's raises the always-ask `kubic-state-write`
  capability, and so does a config-mutating `git config` in bash
  (`--get`/`--list`/single-name reads stay quiet).

## Tool process environment

Every child the exec seam spawns — the bash tool, host `git` calls —
starts from an explicit allowlist (`TOOL_ENV_ALLOWLIST` in
`packages/exec/src/env.ts`: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
`TERM`, `LANG`, `LC_*`, `XDG_*`, `TMPDIR`, `TZ`, `CI`, `NO_COLOR`, `CLICOLOR`,
proxy vars (`HTTP(S)_PROXY`, `NO_PROXY`, either case), trust roots
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`), plus Windows
process basics, matched case-insensitively there), never kubic's inherited environment. Any
secret-shaped name (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`,
`*_CREDENTIALS`) is dropped even when it matches, so a provider API key
in kubic's environment never reaches a tool. `SSH_AUTH_SOCK` and
credential helpers' variables are not passed either.

**Proxy URLs lose their userinfo.** A proxy variable is
allowlisted for reachability, and its value may carry credentials that the
NAME does not reveal — `HTTPS_PROXY=http://user:password@proxy.corp:3128`.
That is a credential, and a credential must never reach an agent-visible
string: the model's shell can read the child env, so the
password would be one `echo $HTTPS_PROXY` away. Every tool child therefore
receives the value with its userinfo stripped — scheme, host, port, path and
query survive verbatim (`http://proxy.corp:3128`) — and the strip is the
same in both spellings of the variable. The strip is a URL-shaped heuristic,
not a parser: it assumes a valid proxy value (the authority ends at the
first `/`, `?` or `#`, and the scheme is anchored at the start), so a raw
separator inside malformed userinfo ends the authority early — the same
reading Python's `urlsplit` gives such a value. A proxy that REQUIRES that
authentication is consequently not usable from a tool child; Kubic does not
broker proxy auth (a tool that needs it must be run outside the model's
shell). `NO_PROXY` lists hosts, never credentials, and is passed through.

## What the model does and does not promise

It promises: every edit recorded and reversible by default, every
dangerous operation gated on an explicit user decision, every timeout
and restart failing closed to deny.

It does not promise isolation (Kubic runs in-process with the user's own
authority) or containment, and there is no prompt-injection prevention
(model output is never trusted). Nor does it promise airtight
confinement (the workspace check is lexical and must be re-checked at
use time) or an airtight control plane: the
`.kubic/` guards are lexical, like every shell detector — `sed -i`, a
script file, a symlink, an interpreter (`python -c`) or a variable-built
path can still reach `.kubic/` from bash without raising
`kubic-state-write` (a `cd`, a quote-split segment, `$HOME`, `$PWD`, a
glob and an `rm` operand are read, but a path assembled from a variable
set elsewhere, a `cd` inside `bash -c`/`eval`/`time` and a subshell `cd`
that undoes an earlier one are not). Approvals plus the journal are the
controls; everything else would be someone else's guarantee.

Journal mechanics live on the [exec package page](../packages/exec.md),
approval wiring on the [host package page](../packages/host.md), and
command behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also [the in-process runtime](in-process.md).

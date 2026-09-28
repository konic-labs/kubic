# Change journal and safety

> Design ref: §42 journal, §41 approvals safety model, §59.1 honest
> limits. Owner: issue
> [#62](https://github.com/konic-labs/kubic/issues/62).

Kubic's safety model has two halves: a VCS-independent change journal
that makes every edit reviewable and reversible, and an approvals
model where the user — never the manager, never the model — decides
what dangerous operations may proceed. Both hold identically in
[solo](solo.md) and [orchestrator](orchestrator.md) modes.

## Change journal (§42)

The journal records every file edit the agent makes, whether or not
the directory is a git repository — `kubic diff` and `kubic undo`
work anywhere. Entries are append-only and persist across sessions,
so undo works after the terminal closes. Durability is claimed exactly
where it is implemented: the appended index line is fsynced before
`append` returns (one fsync per tool write — the price of "reversible";
the store's `durable` knob, default `true`, trades that for a crash
window of one truncated last line). Everything else is atomicity, not
fsync: blobs and undo restores are written tmp+rename in the target's
own directory, so a crash never leaves a half-written file visible
under its real name, but their bytes are not fsynced before the rename,
and the retention compaction rewrite is a tmp+rename with no fsync at
all — a crash right after it can lose more than one truncated last
line. Directory-entry durability of any rename is out of scope — rename
atomicity is the guarantee we rely on. Undo is part of the record, not
an exit from it: every successful `kubic undo` appends its own inverse
entry (attributed `kubic-undo`, the pre-undo content as its before, the
restored content as its after), so `diff` and `log` describe the world
after the undo. `kubic undo --step` is the redo of an edit-shaped undo;
plain `kubic undo` ignores the `kubic-undo` records entirely, so
repeating it restores real work once, then reports `already undone` and
writes nothing. A delete-shaped undo — the file was absent before it —
records no before-content, so it is reported non-reversible and cannot
itself be undone. Review the record, revert a step or a path, check
status and history; entries the
journal cannot reconstruct (recorded hash, no retrievable pre-image)
are reported as non-reversible rather than guessed at. Changes the sweep
captures are bounded the same way: a changed file above 4 MiB — or one whose
utf-8 decode would be lossy (binary content) — is recorded hash-only
(`changed, N bytes`; `diff` shows a size-only line), never as a mangled or
unbounded blob. Retention
bounds keep growth finite: a size cap is enforced on every append,
with opt-in age pruning.

## Approvals (§41)

Dangerous capabilities — network, credentials, privilege escalation,
destructive shell, installs, deploys, pushes, writes outside the workspace,
agent spawning, budget overruns — route to the user first (ask-user by
default) or to deny. The rules are fail-closed:

- The decider is the user. There is no manager-approval path and no
  model self-approval, structurally, not by flag.
- Every ask is time-bounded and denies on timeout; headless runs can
  never hang on an open question.
- The first answer wins; only settled decisions persist, never open
  questions — after a restart, pending asks time out to deny.
- Decisions are session-scoped unless the host explicitly wires a
  shared store.

### Kubic's own control plane (issue #324, §59)

The model never decides its own permissions, so it cannot rewrite the files
that decide them:

- **`kubic-state-write` always asks.** A `write`/`edit` path, a bash
  redirect (`>`, `>>`, `N>`, every one in the command), a `tee` target or a
  `cp`/`mv`/`install` destination under `<workspace>/.kubic/` — `config.toml`,
  `roles/`, anything else there — raises the named `kubic-state-write`
  capability. No `autoApprove` entry answers it, and neither does the
  session's `--full-access` posture (solo or orchestrator worker): on a TTY it
  is a dialog, headless it is denied by name (exit 4). The path check is
  case-folded (`.KUBIC/Config.toml` is the config file on a case-insensitive
  disk).
- **Journal, orchestrator and session state are refused outright.** A write
  into `.kubic/journal/`, `.kubic/orchestrator/` (approvals, the §60 audit
  ledger, decisions, the ask mailbox) or `.kubic/sessions/` is a tool error
  (`refused: … is Kubic control-plane state`), never an ask, whatever the
  posture. The refusal itself is appended to the audit ledger.
- The journal still skips `.kubic/`, so an approved `kubic-state-write` is not
  reversible with `kubic undo` — which is why it is never auto-approved.

## Tool process environment (§3.8)

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
credential helpers' variables are not passed either. Worker processes
use their own launch allowlist plus role-scoped grants.

## What the model does and does not promise (§59.1)

It promises: every edit recorded and reversible by default, every
dangerous operation gated on an explicit user decision, every timeout
and restart failing closed to deny.

It does not promise: isolation (solo runs in-process with the user's
own authority), containment (worktrees separate concurrent writers
only), no prompt-injection prevention (model output is never trusted), or
airtight confinement (the worktree check is lexical and must be
re-checked at use time), or an airtight control plane: the `.kubic/` guards
are lexical, like every shell detector — `sed -i`, a script file, a symlink,
an interpreter (`python -c`) or a variable-built path can still reach
`.kubic/` from bash without raising `kubic-state-write`. Approvals plus the journal are the controls;
everything else would be someone else's guarantee.

Journal mechanics live on the [exec package page](../packages/exec.md),
approval wiring on the [host package page](../packages/host.md), and
command behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also [solo](solo.md) and
[orchestrator](orchestrator.md).

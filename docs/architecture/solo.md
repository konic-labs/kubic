# Solo mode

> Owner: issue
> [#62](https://github.com/konic-labs/kubic/issues/62).

Solo is Kubic's default and its architecture: one agent working
directly in the user's directory. One Pi session plus one agent lane
run in-process — harness, lane, and tools in a single process with
zero IPC on the path. There is no delegation in solo mode and no
second trust zone.

## No isolation — stated plainly

**Solo mode has no isolation.** The run executes in-process with the
user's own authority over files, network, and credentials. There is no
containment and no prompt-injection prevention: model output is never
trusted, and anything the agent can reach, a mistaken or manipulated
instruction can reach too. Solo is a single trust zone, and these docs
never imply otherwise (§59.1).

This is announced, not buried: every process start announces it from one
source (`packages/host/src/limits/solo-warning.ts`), so the two surfaces
cannot drift apart. `kubic run` prints the three-line warning block on
stderr before the first turn; `kubic tui` shows the one-line form in the
welcome block from the first render, keeps the `SOLO` badge in its header on
every frame, and prints the full text on `/safety`. Suppressed for
orchestrator-managed worker children (`KUBIC_WORKER_ID` set — `kubic doctor`
reports that mode's own worktree limit) and by the opt-out
`KUBIC_NO_NOTICE=1`; a `--session` resume still announces, because the rule
is per process start, not per
session.

## The controls that exist instead

With no boundary to lean on, solo relies on two controls:

- **Approvals** — dangerous operations ask the user first
  (ask-user by default) and deny on timeout. See
  [change journal and safety](journal-and-safety.md).
- **Change journal** — every edit is recorded, reviewable with
  `kubic diff`, and reversible with `kubic undo`, including after the
  terminal closes. See
  [change journal and safety](journal-and-safety.md).

## How the lane boots

The lane runs on Pi 1.0's durable harness (`@earendil-works/pi-durable`),
still entirely in-process: one session, one root conversation, no IPC and
no second process.

- **One session, one root conversation.** `Harness.open` opens the
  session's durable `Storage` (the Kubic session lock stays held by the
  session handle for the boot's lifetime) and `harness.root()` returns the
  session's root conversation. A turn is `conversation.submit(...)` →
  `submission.wait(...)`; durable retry, provider-deferred responses and
  crash-safe task checkpoints belong to the harness.
- **Per-process extension registry.** The Kubic tools, the prompt section
  and the budget/policy/span hooks are installed as extensions in a
  registry the process owns and never stores; conversations store
  extension *names*, so every boot re-installs them. Install order is hook
  order: `kubic.budget` (the run-budget meter, which must observe every
  attempt before a guard can block it), `kubic.policy` (the permission
  interceptors), `kubic.spans` (perf) and finally `kubic` (the operation
  tools plus the prompt).
- **One prompt section, byte-stable.** The assembled prompt (role, `cwd:`,
  `tools:`, `meta:`, then the appended skill/role context blocks) is
  installed as a single untagged `kubic` section. The harness stores
  sections as positional `pi.system` entries and re-sends only what
  changed, so an unchanged lane's second turn commits no new system entry
  — the #33/#82 prompt-cache prefix holds by construction. An explicit
  `systemPrompt` stays byte-authoritative.
- **The conversation's agent document is the source of truth.** Model,
  thinking level and offered tools live in the conversation's `pi.agent`
  document and are written with `configure()`. A resumed session keeps its
  stored model under the default `stored` policy; an explicit selection
  (`selected`) switches it and prints the one-line notice; a stored model
  the §58 enterprise gate refuses is dropped for the selection instead.
  The prompt's `tools:` line and the offered tool set are one
  intersection (base ∩ permission classes ∩ role allowlist ∩ enterprise
  policy), so the model is never told about a tool it cannot call (§40.3).
  The thinking level persists per conversation, so #225 is a config/flag
  question only.
- **Compaction** is Pi's mechanism under Kubic's policy: the harness
  compaction reserve is a live getter over the window of the conversation's
  *current* model (clamped to at most a quarter of it). The getter reads the
  committed `pi.agent` document, so every model switch — `escalateSoloModel`,
  the TUI picker, a headless `--model` run — re-clamps on the next request
  with no explicit re-clamp step.

The session handle's `release()` — lock included — stays the caller's job
after `close()`: the lane closes only its harness.

## Interrupted runs

A process that dies mid-turn (SIGKILL, OOM, power loss, orphan reaping)
leaves its durable work unfinished. The next `kubic run --session` or
`kubic tui --session` on that session reopens the same storage and settles
it before accepting a prompt (`packages/worker/src/lane/pending.ts`):

- `kubic run` **resumes** it: `harness.resume()` starts the durable
  scheduler and the run waits for the placed submission under its own
  turn/wall-clock guards. A tool interrupted mid-call is never re-executed;
  it settles as an `interrupted` error result carrying its committed
  output. A resume that cannot settle falls back to the durable abort, so
  the lane is free either way.
- `kubic tui` **aborts** it at boot: its approvals would need the overlay
  before the first render, and the operator is present to re-send. The
  abort drains the lane's kill tree, so a bash group the dead process left
  running is killed.
- `kubic sessions attach` names the pending work read-only, straight from
  the session's storage.

The decision is durable: an abort a dead process already requested stays an
abort, and the next prompt is never a re-run of what already happened.

## When solo is not the mode

Delegation needs [orchestrator](orchestrator.md): an opt-in,
session-scoped mode where the `kubic orchestrate` command is the manager —
it registers the §40 manager toolset, plans one step per worker, fans one
worker process plus one git worktree per subagent out and merges what they
produce; each worker runs its own plan step. Orchestrator requires a
git repository and falls back to solo without one. The trust story
does not change there — approvals and the journal stay the controls.

Implementation detail lives on the [worker package page](../packages/worker.md);
command behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also
[orchestrator](orchestrator.md) and
[journal and safety](journal-and-safety.md).

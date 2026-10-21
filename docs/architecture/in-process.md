# In-process runtime

Kubic is one agent working
directly in the user's directory. One Pi session plus one agent lane
run in-process — harness, lane, and tools in a single process with
zero IPC on the path. There is no delegation and no
second trust zone.

## No isolation — stated plainly

**Kubic has no isolation.** The run executes in-process with the
user's own authority over files, network, and credentials. There is no
containment and no prompt-injection prevention: model output is never
trusted, and anything the agent can reach, a mistaken or manipulated
instruction can reach too. Kubic is a single trust zone, and these docs
never imply otherwise.

One opt-in narrows what the bash tool's commands can reach, and only
those: with `[sandbox] mode = "auto"` or `"required"`, each command the
bash tool runs is wrapped in the operating system's sandbox (Seatbelt on
macOS, bubblewrap on Linux), so it writes only to the workspace and the
temporary directories, opens no network connection unless the network
class is `full`, and cannot read the credential paths — except what an
approved call was approved for. Kubic's own process, its file tools and
every other spawn keep the user's full authority; the sandbox is a limit on
one tool, not isolation of the run. See
[the bash sandbox](../cli/enterprise.md#the-bash-sandbox).

This is announced, not buried: every process start announces it from one
source (`packages/host/src/doctor/no-isolation-notice.ts`), so the two surfaces
cannot drift apart. `kubic run` prints the three-line warning block on
stderr before the first turn; `kubic tui` shows the one-line form in the
welcome block from the first render and prints the full text on `/safety`. The opt-out
`KUBIC_NO_NOTICE=1` suppresses it; a `--session` resume still announces,
because the rule is per process start, not per session.

## The controls that exist instead

With no boundary to lean on, Kubic relies on two controls:

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
  and the policy/span hooks are installed as Pi extensions in a registry
  the process owns and never stores; conversations store extension
  *names*, so every boot re-installs them. Install order is hook order:
  `kubic.policy` (the permission interceptors), `kubic.spans` (timing) and
  finally `kubic` (the operation tools plus the prompt).
- **One prompt section, byte-stable.** The assembled prompt (role, `cwd:`,
  `tools:`, `meta:`, then the appended context blocks: the
  `systemPromptFile` text, the project's `AGENTS.md` files and the skills) is
  installed as a single untagged `kubic` section. The harness stores
  sections as positional `pi.system` entries and re-sends only what
  changed, so an unchanged lane's second turn commits no new system entry
  — the prompt-cache prefix holds by construction. An explicit
  `systemPrompt` stays byte-authoritative.
- **The conversation's agent document is the source of truth.** Model,
  thinking level and offered tools live in the conversation's `pi.agent`
  document and are written with `configure()`. A resumed session keeps its
  stored model under the default `stored` policy; an explicit selection
  (`selected`) switches it and prints the one-line notice; a stored model
  the enterprise gate refuses is dropped for the selection instead.
  The prompt's `tools:` line and the offered tool set are one
  intersection (base ∩ permission classes ∩ role allowlist ∩ enterprise
  policy), so the model is never told about a tool it cannot call.
  The thinking level persists per conversation, so is a config/flag
  question only.
- **Compaction** is Pi's mechanism under Kubic's policy: the harness
  compaction reserve and kept recent window are live getters over the window
  of the conversation's *current* model (the reserve is clamped to at most a
  quarter of the window, the kept window to a quarter of the room below the
  reserve). The getters read the committed `pi.agent` document, so every model
  switch — `escalateLaneModel`, the TUI picker, a headless `--model` run —
  re-clamps on the next request with no explicit re-clamp step. A pending
  manual `/compact` narrows the kept window to 2000 tokens through the lane's
  `ManualKeepScope`, released when the task settles on every exit path.

The session handle's `release()` — lock included — stays the caller's job
after `close()`: the lane closes only its harness.

## Interrupted runs

A process that dies mid-turn (SIGKILL, OOM, power loss, orphan reaping)
leaves its durable work unfinished. The next `kubic run --session` or
`kubic tui --session` on that session reopens the same storage and settles
it before accepting a prompt (`packages/agent/src/lane/pending.ts`):

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

Implementation detail lives on the [agent package page](../packages/agent.md);
command behaviour on the [CLI pages](../cli/README.md).

Back to the [docs index](../README.md). See also
[journal and safety](journal-and-safety.md).

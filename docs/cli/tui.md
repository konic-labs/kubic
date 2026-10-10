# The terminal UI: `kubic tui`

> The interactive surface over the same lane `kubic run` drives. Its keys and
> screen layout are on [TUI keys](tui-keys.md), the approval card on
> [approvals](approvals.md). Back to the [command index](commands.md).

## `kubic tui [--session <id>] [--role <name>] [--model <provider/id>] [--thinking <level>] [--skill <path>]... [--no-skills] [--tools <a,b,...>] [--no-tools] [--dangerously-skip-approvals]`

Interactive TUI: the alt-screen over the agent lane. Tree,
transcript, and status rows render in root order, with the prompt editor
on the bottom row. Below 80 columns the tree hides and transcript plus
status stay. `--session <id>` resumes into an existing session (same
`[A-Za-z0-9_-]` rule as `run` — anything else exits 2 before the lane
boots). Usage errors (unknown option, missing value, any operand) exit 2
on stderr before the screen opens. A `--tools`/`--no-tools` selection follows the same rule: an unknown name or one the
permission classes forbid is refused with the reason before the
alt-screen (exit 2), `--no-tools` is the empty set, and the two are
mutually exclusive. Lane boot failure exits 5 on a missing
session, 6 with no provider available, 1 otherwise, each with one
`error: …` line on stderr (never stdout) before the screen opens. The
`--session` model rule is the same as `kubic run`'s, and it adds the same pins:
`--model <provider/id>`, `KUBIC_MODEL`,
`[model]`, a role's `[roles.<name>].model`, or `KUBIC_PROVIDER=faux` —
the status bar and usage rows name the model the lane actually runs, and a
kept or switched model is named in the first footer. `--thinking <level>` boots the lane at that level under the same rule as `kubic run` (resolved against the session record and the role default, clamped to the model with a named notice); the status bar seeds from the committed level. In the loop,
`/model <provider/id>` switches the live lane: the id is resolved against
the catalogue, committed to the session as a config update, and the
first screen's provider row and the status line both move to it; `/model`
alone opens the model picker, and an unknown or malformed id is refused in
the footer while the lane keeps the model it had. `/scoped-models`
reports the role's resolved allowed set — the entries
the boot selected against, with any per-entry thinking — or that the role
(or a roleless lane) is unconstrained. `/escalate <provider/id> [reason]`
climbs the configured escalation ladder one rung with
the reason recorded — `/model <provider/id>` climbs the same ladder
silently; off-ladder targets, down-steps and exhausted budgets are refused
in the footer with the live model untouched. Three consecutive tool-failure
turns climb one rung automatically, once per run. Every climb appends an
`escalation: <from> → <to> (<reason>)` transcript row and lands on the
trajectory's `model.escalations`. Under an enterprise
`[policy]` the switch passes the same model/provider gate the boot
does: a model outside `allowed_models`/`allowed_providers` is refused in the
footer with the boot's named refusal and the lane keeps its model. A frozen
enterprise `[model]` binds the switch too (`/model` is the same
session override as `--model`): a switch to any other model is refused with
`model '<ref>' refused: the model is pinned by enterprise policy (<pin>);
/model cannot change it`, and naming the pin itself passes. `--model`
is the `cli` layer of the one config load (never patched over the projected
pin), so a frozen enterprise `[model]` beats it — announced by one stderr
note at boot — exactly as it does for `kubic run`. A session left with pending work
by a crashed run has it durably aborted at boot — its
approvals would need the approval card, which is not on screen yet, and the
operator is present to re-send — and the notice row names the outcome
(`pending work: <kind> <id> (<status>) aborted after an
interrupted run`) from the first render, together with the prompt the dead
process had already admitted (`— interrupted prompt: <text>`) when there
was one.

**Explicit skill invocation.** `/skill:<name> [instructions]` expands the booted skill of that name into the submitted turn — its full content followed by the instructions — including skills hidden from the model (`disableModelInvocation`); the hidden skill stays out of the system prompt either way. An unknown name (including a withheld one: role gate, trust gate) is refused in the footer (`skill: unknown skill '<name>'`) and nothing is sent. The colon form only: a bare `/skill`, or the space form `/skill <name>`, reports the usage (`usage: /skill:<name> [instructions]`). An expanded skill is always a prompt, even when its content opens like a slash command. Per-skill rows complete in the editor but never join `/help` or the palette.

**Prompt images.** `/image <path>` attaches one image
to the next submitted prompt — `png`, `jpeg`, `webp` or `gif`, up to 5 MB,
checked by magic bytes rather than the file name, and the footer names the
file and its size (`image attached: screenshot.png 120 KB — Enter sends it`).
Enter with no text sends the attachment on its own (the image is the
prompt), and a non-regular file (a FIFO, a device node) is refused unopened
rather than read.
A terminal that pastes an image inline (iTerm2's `OSC 1337 File=` sequence,
reassembled when the pty splits a large payload across reads; other
terminals have no inline-image paste, so `/image <path>` is the way in)
attaches it the same way. The attachment is refused — with the reason in the
footer and nothing sent — when the file is missing, is not one of those four
formats, is over the cap, or when the live model's own input modalities do
not include images (a `/model` switch to a text-only model drops the
pending attachments and says so). An attached image travels as Pi's own
user-message image content part, so the session stores it and a resumed
session replays it; on a terminal with a kitty or iTerm2 image protocol the
transcript draws the image itself, and everywhere else it renders one
placeholder row. The row names the file and its size while the prompt is
pending (`[image: screenshot.png 120 KB]`); the committed entry stores the
MIME type and the bytes, not the name, so a resumed session shows
`[image: image/png 120 KB]`.

The TUI drives the same lane as `kubic run`, so it installs the same
policy (see **Installed policy** under `kubic run` above): the classes,
the derived allowlist, and the destructive/network/confine guards with the
approval ask. Each decision lands in the ledger with the session id
and the model the lane runs **when the ask resolves** (`provider/id`) —
after the stored-model rule of a `--session` resume and after any `/model`
switch, never the pre-boot pick — the same audit identity the headless
runner records. A challenged call surfaces the approval card — the
interactive path can actually collect a verdict on it — and an unanswered
ask denies on the same bounded wait. That bound also **withdraws the
question**: when it elapses the card for exactly that ask
closes, the next queued ask takes the screen, and a decision pressed later
settles the next ask — never the one nobody is waiting for.

**Full access.** `kubic tui --dangerously-skip-approvals`
— and the bare `kubic --dangerously-skip-approvals` on a terminal — enables
full access for the session it opens or resumes, through the same path as
`kubic run`: `posture.json`, one `posture:full-access` audit row, and a
`warning:` line on stderr before the screen opens. A lane that `/new` or
`/resume` boots in full access names its notice as a transcript row, since the
screen is already up. In the session itself the
same posture can be toggled with `Alt+A` or `/approvals off|on`:
`Alt+A` flips whichever way the session is currently in, while `off`/`on`
name the state of approvals and only report when it is already in force;
turning approvals off (full access) asks for confirmation first, turning them
back on is immediate, and both write
the same posture file and audit rows — the installed policy reads the change
live, so the very next challenged call follows it, and the indicator moves in
the same frame. The header shows `approvals OFF (full-access)` from the
first frame. Off a
terminal the bare form prints the root help and exits 1, like bare
`kubic`. The flag is never written to config.

**The posture is decided at boot.** `kubic run` and
`kubic tui` read the session's full-access posture once, when the lane
boots, from what the flag or `kubic sessions create
--dangerously-skip-approvals` recorded. `posture.json` is never re-read to
decide an ask: a change written during the session (for example by a tool
call) is ignored, the file is restored to the boot posture before the next
ask and at session close, and one `posture:changed-mid-session` row
(`result deny`) is appended to the audit ledger. Every decision row carries
the posture decided at boot.

**Parity with `kubic run`.** The interactive lane carries the
same context the headless one does:

- **Skills:** discovery runs at boot with the same trust gate
  (`KUBIC_TRUST_PROJECT`), so discovered `<skills>` blocks land on the
  interactive system prompt. `--skill <path>` adds an explicit skill
  (repeatable), `--no-skills` turns layered discovery off — and explicit
  `--skill` paths still apply under `--no-skills`, exactly as `run`.
  Relative paths resolve against the invoking cwd, and an
  unresolvable value is a `warning:` line in the transcript: the screen owns
  stderr.
- **Roles:** `--role <name>` loads `.kubic/roles/<name>.md` — else `~/.kubic/roles/<name>.md` — or the
  matching preset embedded in the binary when neither has such a
  document (the five presets ship with `kubic`, and a repo document of the same name replaces its preset) — the document's prompt text replaces the built-in
  constant and its tool set narrows the lane (absence, not approval). Every refusal is fail-closed
  with the named reason (unknown role, contradictory document, missing `## Prompt`, parse failure, untrusted project root); the boot exits before the alt-screen.
- **Journal retention:** the session journal takes the same
  `[journal] retentionDays` projection `run` threads — a TUI session's
  journal age-prunes under config.
- **Model selection:** the same precedence as `run` — an explicit
  pin (`--model <provider/id>`, else `[model]` in config or
  `KUBIC_MODEL`), then the `--role` layer's `[roles.<name>].model`, then
  the first registered model. The first screen and the status line name the
  model the lane actually runs on. An unknown or unavailable pinned model exits
  6 with the named reason before the alt-screen opens. With no pin and no
  provider key at all, the first screen's no-key block is printed to stderr
  instead — `✕ provider  no model provider has a key`, the `export …` lines to
  set one, the local-model and `KUBIC_PROVIDER=faux` alternatives — and the
  exit is 6 (`provider_probe_failed`); no alt screen is entered, so the lines
  stay in the scrollback. A bare `kubic
  --model <provider/id>` on a terminal is `kubic tui --model …`.
- **Agent id and role layers:** `[agent].name` names the lane
  (journal and reconciliation attribution, the id `kubic diff` reports
  for TUI changes) and `[roles.<name>].tools` layers under the role
  document on `--role`, exactly as `run`.
- **Audit identity:** every approval the TUI resolves writes its
  ledger record with the session id and the `provider/id` model the lane
  runs at that moment: the model a resumed session kept (the unpinned default pick never applies) and the one a `/model` switch
  moved it to. The policy is installed before the lane boots,
  so the model is read when each record is written, not frozen at install.
- **Runtime exclude rules:** `kubic tui` ships the same `.kubic/`
  exclude rules before creating state, so a session whose config ever
  relocates state in-repo leaves `git status` clean.

The loop is real: type a prompt, press `Enter` to submit, and the lane
drives it with events streaming into the views — the assistant's
answer appears as it is generated (a plain draft, replaced by the
markdown-rendered committed entry when the message lands), tool calls appear
in the tree, the transcript grows with the committed conversation, and the
status bar fills with usage rows. A resumed session (`--session <id>`)
starts from its committed spend: the status bar is seeded from the
session's `pi.usage` ledger before the first frame, and the tree's root row
picks the same ledger up when the lane attaches on the first turn — so
`$0.00` means an unspent session, never a lost one. While a turn runs the editor disables
submit; `Ctrl-C` cancels the in-flight turn and keeps the session alive,
and a second `Ctrl-C` (or `Ctrl-C` while idle) quits.

**Journal panels and `bash`.** A change made with the file tools reaches
the journal (and both panels) as its tool call ends. A change made with
`bash` is not intercepted, so it is journaled by the reconciliation sweep —
which, in the TUI, runs when a turn that used `bash` **settles** (before the
panels refresh), not only at quit: after such a turn `Ctrl-R` lists the
change as `unattributed` (plus `not reversible` when no pre-image exists —
a bash edit of a committed file carries its git pre-image and undoes) and
`Ctrl-O` follows it. The sweep
walks and hashes the workspace, so turns that ran no `bash` do not pay for
it; it is safe to repeat (an unchanged tree appends nothing). The cost is
real: the sweep is a synchronous walk-and-hash of the whole workspace on the
terminal's thread — about 60 ms for ~700 files, linear in workspace size — so
a large workspace pays it (and the screen pauses) after every turn that used
`bash`.

## Panels

Both panels read the session's own journal through the same projection
`kubic diff` prints (one change per path, latest attribution): once at boot
— so `kubic tui --session <id>` shows earlier turns the first time `Ctrl-R`
opens — after each tool call (throttled to one read per 100 ms burst) and
when a turn settles. Paths and file content are stripped of terminal
control sequences before they are drawn: whole SGR/OSC sequences (so
`FORCE_COLOR` output reads as plain text, not `[31m` noise), carriage-return
overwrites collapsed to what the terminal would show, and tabs expanded by
column.

Each panel opens in its own box between the transcript and the editor,
sized to its content up to half the terminal; `Esc` (or its own key again)
closes it. Both panels scroll: the mouse wheel over the panel moves it (it
does not chain to the transcript while the panel can still scroll), and
`Alt-↓` / `Alt-↑` move through the open panel — the diff panel's files, or a
page of the journal panel. A freshly opened panel starts at its first file,
and a repaint (new journal rows arriving) never yanks the viewport.

## Signals and crashes

`SIGINT`, `SIGTERM` (a supervisor `kill`) and
`SIGHUP` (a closed terminal tab) all take the same quit path — mid-turn
drain, terminal restore, sweep, session close — run it once however many
arrive, and exit `128+signo` (130, 143, 129). A second signal during the
drain ends the wait. An exception in input or render, or an unhandled
promise rejection, restores the terminal first (alt screen left, autowrap
back on, cursor shown, mouse tracking and the Kitty protocol off, cooked
mode), then prints `error: kubic tui crashed: …` on stderr and exits 1.
`Ctrl-Z` suspend is not supported. Kubic runs in-process with your user
authority: no isolation, no containment. The no-isolation statement is on
screen from the first frame: the first screen's isolation row carries it
(with `/safety` beside it), and `/safety` prints the full text from the
limits module on demand. The startup line is suppressed by the opt-out
`KUBIC_NO_NOTICE=1`; see
[`kubic run`](run.md).

Text rendered in the transcript is stripped of terminal control sequences
before it reaches the frame: assistant text and tool output are untrusted
input, so ANSI escapes (`\x1b[2J`, colour codes, cursor moves) and C0
controls such as BEL are removed rather than executed by the operator's
terminal. The renderer's own styling is unaffected.

# TUI keys and screen layout

> What `kubic tui` shows and every key it answers, and how to rebind them.
> Back to [the terminal UI](tui.md).

## Screen layout

Three one-row surfaces frame the transcript. Top to bottom:

- **The header** (one row): `■ KUBIC │ <project>  ⎇ <branch> ●<changed files>`
  on the left and `session <title> │ approvals on │ HH:MM` on the right.
  The project is the repository's top-level directory (or the working
  directory outside a repository, where the branch part is left out); the
  branch and the changed-file count are read with
  `git --no-optional-locks status` when the screen opens and after every
  settled turn, so the read never takes the index lock a tool's own git may
  need. The session title is the session's first prompt cut to 24 cells, or
  the short session id (`01a1…b6b8`) until there is one. The posture reads
  `approvals on`, or
  `approvals OFF (full-access)` in the error colour when the session's
  installed policy auto-approves every challenged call — read from that
  policy, at boot and after every turn, never assumed. As the terminal
  narrows the parts drop right to left — clock, session, approvals, branch —
  and the project name is cut last; the brand never drops, and neither does
  `approvals OFF`. The clock checks its minute every 30 s
  and repaints only when it changed.
- **The agent tree**, sized to its content (at most 6 rows). It starts
  hidden — `Ctrl-T` opens and closes it. Below 80 columns it is hidden
  either way. The tree's root row carries the run glyph, the run's role
  (the `--role` name, cut to 20 columns, or `default`) and the
  session's `$cost in/out` tokens (`● default $0.02 2.0k/1.0k`) — seeded from
  the session's usage ledger when the TUI attaches, then summed from each
  response; each tool row shows the glyph, the tool name, a one-line summary
  of its key argument (the `bash` command, the `read`/`edit` path), the
  duration and a short outcome (a detected test summary like `17 passed`, or
  a non-zero exit code) — a failed call renders `✗` in the error colour,
  never `✓`. Calls are grouped per turn: a new turn starts a new group, and
  earlier turns fold into one `… N earlier calls in M turns` line above the
  live turn (calls beyond the row cap fold into `… N earlier calls`).
- **The transcript**, which follows the end as the turn streams, as blocks
 . Your prompt is a full-width block
  with a red `▌` edge and `you · HH:MM:SS` on the right (it shows the moment
  you submit, before the lane commits it); assistant prose renders as
  markdown behind a `◆` mark: bold headings, inline code on a
  raised surface, `•` bullets, quotes behind a `│`, and fenced code in a
  `┌ ts` / `└` frame with syntax highlighting (highlight.js grammars via
  `lowlight`, loaded when the TUI starts; a block over 2,000 lines or
  200 KB, or in an unknown language, stays plain). A path to a file in the
  project — `src/cart.js:10`, in prose or inline code — becomes a clickable
  `file://` link on terminals that support OSC 8 hyperlinks (elsewhere it
  stays text). Each tool call is one card: a header with its
  state (`●` green done, red failed; the accent spinner and
  `running · 3.00s` while it runs; `◆ … waiting for approval` while an
  approval holds it), the tool name, its target (the command or path) and,
  on the right, the outcome (`✓ exit 0` / `✕ exit 1`, `truncated` when the
  output was clipped) and the duration; then up to five body lines behind a
  `│` gutter — for a failure the error lines first, for a test run its tally
  (`tests 4 · pass 3 · fail 1`) — and a `└ +35 lines   ^X expand` footer.
  The shell record's `[bash exit …]` head, its `--- stdout ---` /
  `--- stderr ---` markers and the exec layer's
  `[kubic: N leading chars dropped …]` notice never show: stderr lines follow
  stdout, and an expanded card's footer names the full-output file. A
  successful workspace read (`read`, `ls`, `find`, `grep`, `git_status`,
  `git_log`, `git_show`, `git_diff`) folds to one line
  (`○ read  src/cart.js … 32 lines · 3ms`); a failed one is a full card.
  An `edit` card shows `+A −R` and the change inline: line
  numbers, removed lines on a red surface with `−`, added lines on a green
  one with `+`, the changed words highlighted, `⋮` for skipped lines —
  twelve rows collapsed (`└ +N more lines   ^X expand`). A `write` that
  creates a file shows `new file +N` and its first eight lines; one that
  replaces a text file shows the diff. The diff rides the tool result's
  details, so the model never pays for it; a session recorded before it
  shows the op's own count instead (`✓ 2 replacements`).
  The model's reasoning shows as one line, `⋯ thought for 4.1s — <its first
  sentence>` (the time is the response's generation time, measured for turns that arrive while the TUI watches — a resumed session's older reasoning reads `⋯ thinking — …`); `Ctrl-X` shows all of
  it. Every settled turn ends with a receipt:
  `✓ turn 18.4s · 4 tools · 1 file +1 −1 · $0.031` with
  `^O review diff   /undo revert` when it changed files (counted from the
  journal rows the turn recorded), or `✕ turn failed · 2.1s · <reason>` /
  `○ turn cancelled · 0.8s`. Receipts are drawn by this TUI process only —
  they are not written to the session.
  `Ctrl-X` expands every card and wraps its lines in full. A context
  compaction is a `─── compacted · auto ───` rule with the summary under it,
  collapsed the same way.
- **Block mode**: `Esc` on an idle, empty
  editor walks the transcript by blocks — each prompt, answer, thinking,
  tool card and turn receipt. The last block is selected first and shows an
  accent `▌` edge on every row; the transcript scrolls to keep it in view.
  `↑`/`↓` or `k`/`j` move a block, `g`/`G` jump to the first/last; `y`
  copies the block (a tool card's full output, an answer's markdown, a
  prompt's text) and `Y` its command (a tool's name and arguments) to the
  system clipboard via OSC 52 — through tmux's passthrough when `TMUX` is
  set; up to 100 KB (`copied 1.2 KB`, else `too large to copy — ⏎ view and
  select`), and never claimed on a terminal known to drop it (Apple's
  Terminal.app says so instead). `⏎` opens the block whole in a viewer
  (`↑↓`/`j k` scroll, `PgUp/PgDn` a page, `g`/`G` the ends, `y` copy, `esc`
  close); `x` expands or collapses just that block. `i`, `Esc` or any other
  key returns to typing — a printable key is typed into the editor. The
  hint row reads `↑↓ move  ⏎ view  y copy  Y copy command  x expand … esc
  back`.
- **The first screen**: an empty session opens on
  a preflight instead of a wall of keys — the wordmark with the version
  (`■ kubic <version>` below 70 columns); PREFLIGHT rows `✓ provider` (the
  model and where its key comes from, or `◆ … testing provider` for faux),
  `✓ project` (the path, `git <branch> · clean | N changed`, or `not a git
  repository`), `✓ trust` (`.kubic/config.toml loaded`, only when the
  project has a layer), `✓ journal` and `○ isolation` (what running with
  no isolation means, with `/safety`); START (`⏎ describe a task below`,
  then `/ commands  @ attach a file  ^P palette  ? all keys` from the key
  bindings); and
  RECENT IN THIS PROJECT — up to three sessions with their age, first prompt
  and `turns · cost`, then `/resume to open one`. It is not a transcript
  entry: the first prompt (not a command) clears it, a resumed session with
  history never shows it, and `/new` brings it back. `?` on an idle, empty
  editor lists every key binding, grouped (editor, session, transcript,
  panels, approvals), with the key each has now.
- **The notice row** above the editor — the "footer" the rest of this page
  refers to: a command's reply, a refusal, a turn's outcome
  (`cancelled`, `error: …`), the lane's retry or compaction activity, and,
  while a turn runs, the working line `⠹ Working · 0:12 · ↑ 9.2k ↓ 640 tok ·
  3 tools … esc interrupt   ⏎ queue a message` (tokens once a usage row
  reported them). It takes no row when it has nothing to say, and wraps to at
  most two rows.
- **The editor**, framed: `┌─…─┐`, `│ › <draft>   @ file  / cmd │`,
  `└─…─┘`. The caret is the only red on screen while you type; the box grows
  with a multi-line draft (Pi's `↑ 3 more` scroll markers stay in its rules)
  and the `/`-command and `@`-file completions open below it. Mid-turn it is
  a queue box: `› type to queue — sent when this turn ends`.
- **The status line** (one row): `● <model> · <thinking>  │  ctx ━━━━──────
  31% of 200k  │  $0.031  │  journal 2 changes` with the turn's
  state word on the right — `ready`, `working` (the mark becomes the
  spinner), `needs approval`, `cancelling…` or `error` (the last turn
  failed; the next one clears it). The context gauge appears once the lane
  has reported a committed request and the model's window is known; it turns
  to the warning colour at or above the auto-compaction threshold (window
  minus the reserve; roughly 87% of a 128k window, higher on larger ones), so
  the warning is the signal that the next turn will compact. The journal
  count is the session journal's changes (hidden at zero). As the terminal
  narrows the window size drops first, then the journal count, the gauge
  cells, the thinking level and the context segment; the model name is cut
  last, and
  the cost and the state word never drop.
- **The key-hint row**: the keys that act right now, read from the key
  bindings (a rebound action shows its real key; an unbound one is not
  hinted). Idle: `⏎ send  ^J newline  / commands  @ file  ^P palette  ^O
  diff  ^R journal … ^C ^C quit` (`⇧⏎ newline` on terminals that report
  Shift+Enter, `@ file` when file mentions are available). While a turn
  runs: `esc interrupt  ⏎ queue  alt+⏎ steer  ^X expand output  ^P palette
  … ^C ^C quit`. With an
  approval pending: its allow and deny keys. With the palette open: `↑↓ move
  ⏎ run  tab next group  → details … esc close`. With the model picker
  open: `↑↓ move  ⏎ switch  → expand provider … esc keep current`. With
  another picker or a dialog open: `↑↓ move  ⏎ select  esc cancel`.
- **The palette** (`Ctrl-P`): one fuzzy search over four groups,
  in this order — **COMMANDS** (the slash-command registry: name, summary,
  and the key the bindings give it now), **MODELS** (the usable catalogue,
  `provider/id` with its context window and whether it thinks, the live one
  marked `● … current`), **SESSIONS** (this project's other sessions, by
  their first prompt, with their age and turns — the rows `/resume` lists)
  and **FILES** (the project's files, at most 2,000). A group with
  nothing matching is hidden, and each shows at most six rows until `tab`
  focuses it. Every word of the query must match a row's name in order, or
  appear in a command's summary (ranked below a name match); the matched
  letters are drawn in the accent colour, and the best match of any group is
  selected. With nothing typed it shows the commands this session ran (the
  first six commands before any) and the live model. `⏎` runs the row: a
  command runs exactly as if it were typed (one that needs its argument —
  `/image <path>` — is put in the editor to finish), a model switches
  like `/model`, a session resumes like `/resume`, a file inserts
  `@<path> ` at the cursor. `→` shows the selected row in full in a footer
  line, `esc` closes. The palette floats over the screen, which dims (no
  colour, every row in the faint text colour) while it or a picker is open;
  the key-hint row stays lit with the palette's own keys. Models and
  sessions arrive after the first frame, so a slow catalogue never holds the
  palette up. It needs 60 columns; it is 80 cells wide, or 70% of a narrower
  terminal, and at most 70% of the rows tall.

Colour follows the Konic palette on truecolor terminals, falls back to
256/16 colours, and is off for `NO_COLOR`, `TERM=dumb`, or a non-TTY
stdout (`FORCE_COLOR=0..3` overrides). The palette is selectable: `[ui]
theme` takes a built-in name (`default`/`dark`, the shipped brand palette,
`light`, or `terminal` for the terminal's own colours) or a path to a JSON
theme file (design-token roles, `/README.md`), resolved and
validated before the screen opens — a missing or invalid file is one
`error: theme '<ref>': …` line on stderr and exit 2. A custom theme's
truecolor values are downgraded to the terminal's colour level exactly like
the built-in palette; see `[ui] theme` under
[configuration](configuration.md).

| Key | Meaning |
| --- | --- |
| `Enter` | **Submit** the prompt (an empty draft submits nothing); typing `/` opens the editor's autocomplete over the registry's commands, and `Tab`/`Enter` completes the name. A submit while a turn runs is **queued as a follow-up** in the conversation's own inbox (pi-durable `whenBusy: followUp`): a dim `queued: …` row appears under the transcript the moment the harness admits it, and the harness delivers it — its own user entry, answer, usage row and journal effects — when the running turn settles. A refused submit never eats the draft — it goes back into the editor, and the footer says why. |
| `Alt+Enter` | **Steer** the running turn with the draft: the text joins the work already in flight (the harness places it after the current tool round), and the editor is cleared like `Enter`. With no turn running it submits the draft exactly like `Enter`. An empty draft steers nothing. |
| `/model <provider/id>` | Switch the live lane's model (the session override): resolved against the catalogue, committed to the session's agent document (a resume restores it), and shown in the welcome block and status line. `/model` alone opens the **model picker** (the same as `Alt+M`); an unknown or malformed id is refused in the footer and the lane keeps its model. |
| `/thinking <level>` | Set the live lane's thinking level (thinking.cycle): one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — clamped to what the current model supports, and the footer reports the effective level (`thinking: high`, or `thinking: off (clamped from xhigh)` when they differ). `/thinking` alone opens a picker of the levels the live model supports, the live one marked `● … current` (`Esc` keeps it); an unknown level is refused by name with the vocabulary. Committed through the conversation's agent document, so a resume restores it. Refused while a turn runs. |
| `Alt+M` | **Model picker** (model.select): one group per provider — the live model's first — headed by where its key comes from (`ANTHROPIC  ● key from ANTHROPIC_API_KEY`); each model shows `● … current` for the live one and its context window and whether it thinks (`200k ctx · thinking`). A provider with more than eight models folds behind `▸ expand (→)`. Providers without a key are listed greyed with the variable to set (`OPENAI  ○ no key  set OPENAI_API_KEY`, named by Pi's own auth check) and their models are never offered. The **thinking row** at the bottom steps, with `←`/`→`, through the levels the selected model supports (the live level marked, a level the model lacks clamped down): `Enter` switches the model through the same resolution and refusals as `/model <provider/id>` and then sets the chosen level, so model and effort are one decision. Typing filters (by `provider/id`), and `Esc`/`Ctrl-C` cancels, leaving the model unchanged. Refused while a turn runs. **macOS:** Option sends `µ` for Alt+M unless the terminal sends Esc+ for Option (iTerm2: Profiles → Keys → Left Option key: Esc+; Terminal.app: "Use Option as Meta key") — `/model` or `Ctrl-P` reach the same picker either way. The overlay needs a terminal at least 60 columns wide (Pi refuses to composite it below that); on such a terminal the picker does not open and the footer says `model picker unavailable on this terminal — use /model <provider/id>` — a terminal resized below the minimum while it shows closes it the same way. |
| `Alt+T` | **Cycle the thinking level** over the levels the live model supports (thinking.cycle), committing each step exactly like `/thinking <level>`. Refused while a turn runs. |
| `/compact [instructions]` | Compact the session's context now: the harness summarizes the older history into one `pi.compaction` entry while the most recent turns stay verbatim, and optional `instructions` focus the summary verbatim (`/compact keep the failing test names`). The command text never reaches the model. The footer reports `compacted: <tokensBefore> tokens → summary`, `nothing to compact: no history older than the most recent turn (<tokens> tokens of context)` when the session holds no history older than its latest turn (nothing is admitted), `nothing to compact: no cut point before the most recent turn (<tokens> tokens)` when the harness finds no cut point, or the harness' own failure message. In both `nothing` cases nothing is placed, and the footer never claims a cut. The user's `/compact` keeps about 2000 tokens verbatim, cut at a message boundary, whatever the model window; Ctrl-C cancels a running compaction (`compaction cancelled`). Refused while a turn runs. |
| `/help [command]` | List the registered slash commands — and the keys that reach the same actions — generated from the registry, or one command's usage line. The list lands in the transcript. |
| `/session` | Report the live session: id, workspace, model, thinking level, tokens (in/out/cached) and cost, from the rows the status line already carries. |
| `/safety` | Print the honest limits into the transcript, in full and verbatim from the limits module: that the session runs in-process with your authority (files, network, credentials), with no containment and no prompt-injection prevention, and that the controls are approvals plus the change journal. Answered even where the startup notice is suppressed (`KUBIC_NO_NOTICE=1`), because you asked. A local read: nothing reaches the model. |
| `/new` | Close the current session and boot a fresh one **without leaving the alt-screen**: the transcript, tree, usage rows and panels clear, and the next prompt runs on the new lane. The old session stays on disk (`kubic sessions list`). Refused while a turn runs (`session: finish the current turn before switching`) — the lane swap is the quit path's race, not a mid-turn one. |
| `/resume` | Pick one of this project's other sessions (newest first, at most 30): each row is its first prompt, with its age, turns and cost (`2m ago · 4 turns · $0.03`), read without a lock the way `kubic cost` reads. A session another `kubic` holds is greyed `in use by another kubic` and cannot be chosen. Choosing one attaches to it and loads its transcript, in the same alt-screen. Needs a terminal wide enough for the picker — otherwise the footer says so. Refused while a turn runs, like `/new`. |
| `/theme [name]` | **Theme picker**: the built-ins `dark`, `light` and `terminal`, and the configured `[ui] theme` file if there is one. Moving the selection previews each theme live; `Enter` keeps it for this session and prints `to keep it: [ui] theme = "<name>" in ~/.kubic/config.toml` (the config is never written); `Esc` restores the theme from before. `/theme <name>` switches directly; an unknown name is refused with the choices. |
| `/tree` | Pick an earlier prompt and **retry from there in a fork** (`session.fork`): a picker lists this session's prompts newest first (`#<entry>  <prompt>`); choosing one forks the session into a **new** session just *before* that prompt (the same fork as `kubic sessions fork --at`), switches the TUI to it in the same alt-screen, and puts the prompt back in the editor to edit and resend. The original session is untouched and keeps the abandoned path (`kubic tui --session <old id>` / `/resume` returns to it). Needs a terminal wide enough for the picker; refused while a turn runs. |
| `/fork <entry>` | Fork this session **at** `<entry>` (inclusive; `kubic sessions attach <id> --ids` prints the ids) into a new session and switch to it, the editor left as it was. `/fork` without an integer entry is refused with the usage line. A fork that fails (an entry the session does not have) re-attaches the session you were in and names the reason on the footer. Refused while a turn runs. |
| `/diff` | Open the diff panel — the same panel `Ctrl-O` toggles. |
| `/undo` | Restore the session journal's changes (the same plan/apply path as `kubic undo`, without `--step`): the footer reports `undo: N restored, M skipped` and warnings land in the transcript. Refused while a turn runs (`undo: finish the current turn before switching`) — it rewrites the workspace the turn is working in. |
| `/image <path>` | Attach one image (`png`, `jpeg`, `webp`, `gif`, ≤ 5 MB — verified by magic bytes) to the next submitted prompt. The footer names the file and its size, and the prompt renders it (the real image on kitty/iTerm2 terminals, a `[image: <name> <size>]` row otherwise; a resumed session's committed entry has no file name and shows the MIME type instead). Enter on an empty draft sends the attachment alone. Refused in the footer when the path is not a regular file, the file is missing or unsupported, it is over the cap, or the live model takes no image input — nothing is sent. A pasted inline image (iTerm2 `OSC 1337`, reassembled across reads) attaches the same way. |
| `/quit` | Leave the TUI (same as `Ctrl-D` on an empty draft). |
| `/foo` (unknown) | **Refused locally** — `unknown command '/foo' — /help lists the commands` on the footer, with the draft kept in the editor. A slash command is never sent to the model; `//text` is the escape hatch for a prompt that starts with a slash. |
| `Ctrl-P` | Open the **palette**: fuzzy search over commands, models, sessions and files — `↑↓` move, `⏎` runs the row, `tab`/`Shift+Tab` focus the next/previous group, `→` details, `Esc`/`Ctrl-C` close. See *The palette* above. |
| `Alt+A` | **Toggle full access** for this session: enabling opens a confirmation dialog naming the consequence (`Ctrl-S` confirms, `Esc` cancels — a bare printable letter never does); disabling takes effect immediately. Either way `posture.json` is written, one `posture:full-access` / `posture:approvals` row is appended, and the status-bar indicator moves in the same frame. While an **approval is pending** the toggle refuses (`approvals: answer the pending request first`): the confirmation is a modal of its own and the approval owns the keys until it is answered. `kubic tui --dangerously-skip-approvals` is the boot-time equivalent. |
| `/approvals [on\|off]` | The same posture, by direction: `/approvals` alone reports the live posture. `on` opens the confirmation — and in a session that is **already** on it only reports (`approvals: full access already ON for this session`), never flipping the other way or opening a dialog. `off` disables immediately; in a session that is already off it only reports (`approvals: enforced — nothing to change`) and writes no second row for a change that did not happen. Any other argument is refused by name. |
| `Ctrl-J`, `Shift+Enter`, `\` then `Enter` | Insert a newline (multi-line entry). |
| `@` | **Mention a file**: typing `@` and part of a path opens a completion popup of matching workspace files — fuzzy, file-name and path-prefix matches first, at most 50 — and `Tab` (or `Enter` on the popup) inserts the workspace-relative path as `@path ` (`@"path with spaces" ` when it needs quoting). The list is the walk the `find` / `grep` tools use: `.gitignore` rules (nested ones included) are honoured and `node_modules` / `.git` are skipped, so an ignored file is never offered; it is refreshed at most every 2 s. **Only the path is sent** with the prompt — no file content is attached; the model reads the file with its own tools when it needs it. `/` commands complete through the same popup. |
| `Up` / `Down` | Recall earlier prompts on an empty draft (Pi's editor history; consecutive duplicates collapse to one). `kubic tui --session <id>` seeds it from the resumed session's committed prompts, so `Up` recalls what the previous process sent — the newest 100, the same bound the editor keeps for live prompts. |
| `Ctrl-T` | Show / hide the tree row (hidden by default). |
| `Ctrl-O` | Toggle the **diff panel** — the last tool call that changed files (or, when a `bash` call changed something the file tools did not journal, that turn's reconciled change), rendered as unified hunks. Every file of the call is rendered under its own `path — op (file k/N)` header; the panel scrolls, and `Alt-↓` / `Alt-↑` cycle its files. |
| `Ctrl-R` | Toggle the **journal panel** — every change in the session journal, including changes made with `bash` (filter by path on the command line with `kubic diff --path`). `Alt-↓` / `Alt-↑` page through it. |
| `Ctrl-X` | Expand / collapse every tool output block. Collapsed, a block shows the first 5 lines, each cut at the terminal width, with a `… +N lines · lines clipped (ctrl+x to expand)` hint whenever anything is hidden or cut. Expanded, every output line **wraps** (hanging indent under the `⎿`) and the tool call's args summary wraps too, so a long diagnostic, stack frame or path is readable in full. |
| `alt+down` | With a panel open: the diff panel's next file (wrapping), or the journal panel's next page. Ignored while both panels are closed. |
| `alt+up` | With a panel open: the diff panel's previous file (wrapping), or the journal panel's previous page. Ignored while both panels are closed. |
| `a` | Approval card: **allow once** — this call only, after the arming delay and the quiet period, and only while the card can show the whole command. Nothing is stored: the next identical call asks again. |
| `Ctrl-S` | Approval card: **allow for the session** — after the arming delay and the quiet period, and only while the card can show the whole command; never a bare letter. Latched in `<session>/approvals.json`; identical calls in this session are not asked again (also after re-attach). |
| `d`, `Esc` | Approval card: **deny** the challenged call. `Esc` acts at once (the only immediate action), `d` after the arming delay. A denial latches for the session like `Ctrl-S`, so the same operation is refused without asking again. |
| `v` | Approval card: show the next page of a command too tall for the card, or an edit's whole diff (never decides). |
| `?` | Approval card: open (and close) the model's explanation for the ask (never decides). |
| `c` | Approval card: **deny with a comment** — opens a one-line input on the card; `Enter` denies with `denied by the user: <comment>` as the reason the model reads (an empty comment is a plain deny), `Esc` goes back to the card. At most 500 characters; recorded in the ledger as the denial's reason. Like `d`, the denial latches for the session. |
| `e` | Approval card: **edit the command, then allow it** (shell asks only) — opens the proposed command in a one-line input; `Enter` runs what you typed instead. The edited command is judged again from the start, so an edit that is itself destructive asks again; an unchanged command is a plain allow once, an emptied one is not accepted. The call's result opens with `[edited by the user — ran: <yours> (proposed: <the model's>)]`, so neither the model nor the transcript takes it for the proposed command's output. Nothing is latched; the ledger records both commands. |
| `A` | Approval card: **allow all edits this turn** (an edit or write ask a role's `requires` raised inside the workspace) — this call and every such ask until the turn ends. Never another capability: a write outside the workspace, into `.kubic/` or onto credentials still asks. The status line says `edits auto-approved this turn` while it applies; nothing is latched. |
| `Ctrl-C` | **Interrupt** the in-flight turn and keep the session; a second press while the interrupt drains quits. Idle, **a composed draft is never discarded**: the first press clears it (`^C: draft cleared`); on an empty editor a press shows `press ^C again to quit` on the notice row for 2 s, and a second press inside that window quits. **Cancelling clears the queue**: the abort withdraws every queued follow-up, and the footer names the count (`cancelled · dropped 2 queued prompts`). A prompt queued after a *failed* run stays in the inbox and is placed by the next submit (pi-durable's own rule). |
| `Esc` | **Never quits**. It closes the editor's dropdown or an open picker or dialog; during a turn it **interrupts** it like the first `Ctrl-C` — the session and the draft stay, and a second `Esc` while the interrupt drains does nothing. Idle on an empty editor it enters **block mode** (see *Block mode* above). While an approval is pending it denies. For a one-press quit key, bind `app.exit` in `~/.kubic/keybindings.json`. |
| `Ctrl-D` | Quit on an empty draft; while typing it stays delete-forward. |
| `PageUp` / `PageDown` | Scroll the transcript one page (pi-tui's alt-screen binding; the editor does not see these keys). |
| `Home` / `End` | Scroll the transcript to its top / bottom — which is why they do not move the editor's cursor: `Ctrl-A` / `Ctrl-E` move to the line start / end instead. |
| `Ctrl-Up` / `Ctrl-Down` (`Ctrl-Shift-Up` / `Ctrl-Shift-Down`) | Jump to the previous / next prompt in the transcript. |
| `Ctrl-Shift-F` | Search the transcript: `Enter` (or `Ctrl-G`) selects the next match, `Shift-Enter` (`Ctrl-Shift-G`) the previous one, `Esc` closes the search and returns the keys to the editor. |
| EOF (closed stdin) | Quit — a detached tty or `kubic tui < /dev/null` never hangs the alt-screen. |

**Retries and compaction on the footer**: while
the harness waits to retry a transient model error the footer under the
editor reads `⟳ retrying · attempt <n> — <error>`, and while it compacts the
context `⟳ compacting context…`. The line outranks every other footer line
while it lasts (it is why the turn looks idle) and clears the moment the
retry lands or the compaction finishes. The harness reports the attempt and
the error only — no retry budget or countdown is shown because none is
reported.

## Keybindings file (`~/.kubic/keybindings.json`)

Every key in the table above that Kubic claims ahead of the editor is an
**action** in one keybinding registry, and
`~/.kubic/keybindings.json` rebinds actions: a JSON object of
`"action": "key"` or `"action": ["key", ...]` (a list replaces the defaults;
`[]` unbinds the action). Key ids are pi-tui's — `ctrl+g`, `alt+enter`,
`ctrl+shift+f`, `escape`, a single character — case-insensitive, modifiers in
any order. A rebound action works under its new key everywhere at once: the
dispatch, the idle key hints and the welcome block; the old key falls through
to the editor. The editor's own keys (`Enter`, `Ctrl-J`, `Ctrl-A`/`Ctrl-E`,
…) and pi-tui's alt-screen keys (`PageUp`/`PageDown`, `Home`/`End`, …) are
Pi's and are not in the registry.

```json
{ "panel.diff": "ctrl+g", "panel.journal": "alt+g" }
```

**Conflicts are reported at boot** (a `warning:` line on stderr before the
alt-screen opens; the TUI still starts). A user binding beats a default: the
default action loses that key (`keybinding: ctrl+r now runs panel.diff
(override), so panel.journal no longer has it`, plus `panel.journal is
unbound` when nothing is left). Two user bindings on one key are a conflict —
the first action in the table below keeps it and both are named. Approval
keys conflict only with each other (the approval owns the keys while it
shows, which is why `Esc` can be both the global cancel and the approval deny).
**A broken file refuses the boot** (`error: keybindings '<file>': …`, exit 2,
nothing opens): invalid JSON, an unknown action, a malformed key id, or a
file that is not a regular file or is over 64 KB. A missing file means the
shipped bindings.

| Action | Default keys | What it does |
|---|---|---|
| `app.interrupt` | `ctrl+c` | interrupt the running turn; idle: clear the draft, then press twice to quit |
| `app.cancel` | `escape` | close the open dropdown or overlay; else interrupt the running turn — never quits |
| `app.exit` | unbound | quit on an empty draft (clears a draft first); bind a key to get a one-press quit |
| `app.eof` | `ctrl+d` | quit on an empty draft; delete-forward while typing |
| `app.palette` | `ctrl+p` | open the command palette |
| `help.keys` | `?` | list every key (on an idle, empty editor; elsewhere `?` is typed) |
| `view.tree` | `ctrl+t` | toggle the tree |
| `panel.diff` | `ctrl+o` | toggle the diff panel |
| `panel.journal` | `ctrl+r` | toggle the journal panel |
| `transcript.expand` | `ctrl+x` | expand / collapse tool output |
| `prompt.steer` | `alt+enter` | steer the running turn (submit when idle) |
| `model.pick` | `alt+m` | open the model picker |
| `model.thinking` | `alt+t` | cycle the thinking level |
| `approvals.fullAccess` | `alt+a` | toggle full access for this session |
| `panel.next` | `alt+down` | open panel: next file (diff) / next page (journal) |
| `panel.previous` | `alt+up` | open panel: previous file (diff) / previous page (journal) |
| `approval.allowOnce` | `a` | approval: allow once |
| `approval.allowSession` | `ctrl+s` | approval: allow for the session |
| `approval.deny` | `d`, `escape` | approval: deny |
| `approval.comment` | `c` | approval: deny with a comment for the model |
| `approval.edit` | `e` | approval: edit the command, then allow it |
| `approval.allowEdits` | `shift+a` | approval: allow all edits this turn |
| `approval.explain` | `?` | approval: show why the model asked (the card's explanation row) |
| `approval.page` | `v` | approval: next page of a long command |

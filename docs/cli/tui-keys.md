# TUI keys

> Every key the TUI answers, by where it applies, and how to rebind them. How
> the screen works is on [the TUI](tui.md).

Keys are written `Ctrl+O`, `Alt+M`, `Shift+Enter`; the TUI's own hints show
them as `^O`, `alt+m` and `⇧⏎`. `?` on an idle, empty editor lists them all
with the key each has now.

## Writing and sending

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt. While a turn runs, queue it for when the turn ends ([running a turn](tui.md#running-a-turn)). |
| `Alt+Enter` | Steer the running turn with the draft; with no turn running, send it. |
| `Ctrl+J`, `Shift+Enter`, `\` then `Enter` | Insert a newline. |
| `/` | Complete a slash command ([slash commands](tui.md#slash-commands)). |
| `@` | Complete a workspace file path ([the editor](tui.md#the-editor)). |
| `Up`, `Down` | On an empty draft, recall earlier prompts. |
| `Ctrl+A`, `Ctrl+E` | Move to the start or end of the line. |
| `Ctrl+D` | Delete forward; on an empty draft, quit. |

## The turn

| Key | Action |
| --- | --- |
| `Esc` | During a turn, interrupt it (a second `Esc` while it drains does nothing). Otherwise close the open completion, picker, dialog or panel; on an idle, empty editor, enter [block mode](#block-mode). It never quits, and with an approval pending it denies. |
| `Ctrl+C` | Interrupt the running turn and keep the session; a second press while the interrupt drains quits. Idle, clear the draft, then press twice within 2 s to quit. |
| `Ctrl+X` | Expand or collapse every tool card. |

## Views and panels

| Key | Action |
| --- | --- |
| `Ctrl+P` | Open the [command palette](tui.md#the-palette). |
| `Ctrl+O` | Open or close the [diff panel](tui.md#panels). |
| `Ctrl+R` | Open or close the [journal panel](tui.md#panels). |
| `Alt+↓`, `Alt+↑` | With a panel open: the diff panel's next or previous file (wrapping), or the journal panel's next or previous page. |
| `Ctrl+T` | Show or hide the [agent tree](tui.md#the-agent-tree). |
| `Alt+M` | Open the [model picker](tui.md#models-and-thinking). |
| `Alt+T` | Cycle the thinking level over the levels the model supports. |
| `Alt+A` | Turn approvals off, after a confirmation, or back on ([approvals off](tui.md#approvals-off)). |
| `PageUp`, `PageDown` | Scroll the transcript one page. |
| `Home`, `End` | Scroll the transcript to its top or bottom. |
| `Ctrl+Up`, `Ctrl+Down` | Jump to the previous or next prompt (`Ctrl+Shift+Up` and `Ctrl+Shift+Down` too). |
| `Ctrl+Shift+F` | Search the transcript: `Enter` or `Ctrl+G` for the next match, `Shift+Enter` or `Ctrl+Shift+G` for the previous one, `Esc` to close. |

`Home` and `End` scroll the transcript, which is why they do not move the
editor's cursor; `Ctrl+A` and `Ctrl+E` do. The editor never sees `PageUp` and
`PageDown`.

## The approval card

| Key | Action |
| --- | --- |
| `a` | Allow this call once. |
| `Ctrl+S` | Allow it for the session. |
| `A` | Allow every edit asked for in the workspace until the turn ends. |
| `d`, `Esc` | Deny it; `Esc` acts at once. |
| `c` | Deny it, with a comment the model reads. |
| `e` | Edit the command, then run your version. |
| `v` | Show the next page of a long command, or an edit's whole diff. |
| `?` | Show or hide the model's explanation. |

What each key records, the arming delay that keeps type-ahead from answering,
and what the card does when it cannot show the whole command are on
[approvals](approvals.md#the-cards-keys).

## Block mode

`Esc` on an idle, empty editor walks the transcript by blocks
([block mode](tui.md#block-mode)):

| Key | Action |
| --- | --- |
| `↑`, `↓` or `k`, `j` | Move a block. |
| `g`, `G` | Jump to the first or last block. |
| `y` | Copy the block: a tool card's full output, an answer's markdown, a prompt's text. |
| `Y` | Copy its command: a tool's name and arguments. |
| `Enter` | Open the block whole in a viewer. |
| `x` | Expand or collapse this block. |
| `i`, `Esc` | Back to typing; any other printable key is typed into the editor. |

## Session tree

`/tree` opens the [session tree](tui.md#sessions); while it is open it owns
every key:

| Key | Action |
| --- | --- |
| `↑`, `↓` | Move, wrapping. |
| `←`, `→` | Page up or down. |
| `Alt+←`, `Alt+→` | Fold a branch or go to the start of its segment; unfold it or go to the next branch point. |
| `Enter` | Go to the selected entry; on a prompt, branch before it and edit it. |
| `Esc` | Clear the search, then close. |
| Typing | Search: every word must appear in a row. |
| `Ctrl+D`, `Ctrl+T`, `Ctrl+U`, `Ctrl+L`, `Ctrl+A` | Show the default rows, hide tool results, show prompts only, labelled entries only, or everything; the same key again returns to the default. |
| `Ctrl+O`, `Ctrl+Shift+O` | Cycle the filters. |
| `L` | Label the selected entry; an empty label removes it. |
| `T` | Show when the labels were set. |
| `Ctrl+X` | Copy the entry's text. |

## How keys are read

Keys are classified by the terminal library's key decoder, not by matching raw
bytes, so they work on terminals that negotiate the Kitty keyboard protocol
(`Esc` arrives as `\x1b[27u` rather than `\x1b`, `Ctrl+D` as `\x1b[100;5u`,
`Ctrl+C` as `\x1b[27;5;99~`) as well as on terminals that send the legacy
control bytes. On terminals that also report key release and repeat (Kitty,
Ghostty, WezTerm, foot, recent iTerm2), each key acts on its press only: a
release is ignored, so a toggle never cancels itself on key-up, and a `Ctrl+C`
cancel or an `Esc` deny never becomes a quit. A held key repeats in the editor
(a held `Backspace` keeps deleting), but repeats of the global keys and the
approval keys are ignored, so a held `Ctrl+O` does not strobe the panel. Every
key repaints the screen at once, even with no turn running. A refused cancel
is reported in the footer (`cancel failed: …`) instead of being swallowed: the
turn keeps running, and the key is never a silent no-op.

## Keybindings file (`~/.kubic/keybindings.json`)

Every key above that Kubic claims ahead of the editor is an **action** in one
keybinding registry, and `~/.kubic/keybindings.json` rebinds actions: a JSON
object of `"action": "key"` or `"action": ["key", ...]` (a list replaces the
defaults; `[]` unbinds the action). Key ids are pi-tui's (`ctrl+g`,
`alt+enter`, `ctrl+shift+f`, `escape`, a single character), case-insensitive,
with the modifiers in any order. A rebound action works under its new key
everywhere at once: the dispatch, the idle key hints and the first screen; the
old key falls through to the editor. The editor's own keys (`Enter`, `Ctrl+J`,
`Ctrl+A`, `Ctrl+E`, …) and pi-tui's alternate-screen keys (`PageUp`,
`PageDown`, `Home`, `End`, …) are Pi's and are not in the registry.

```json
{ "panel.diff": "ctrl+g", "panel.journal": "alt+g" }
```

**Conflicts are reported when the TUI starts**, as a `warning:` line on stderr
before the screen opens; the TUI still starts. A user binding beats a default:
the default action loses that key (`keybinding: ctrl+r now runs panel.diff
(override), so panel.journal no longer has it`, plus `panel.journal is
unbound` when nothing is left). Two user bindings on one key are a conflict:
the first action in the table below keeps it, and both are named. Approval
keys conflict only with each other (the approval owns the keys while it shows,
which is why `Esc` can be both the global cancel and the approval's deny), and
so do the session tree's, which owns every key while it is open.

**A broken file stops the TUI from starting** (`error: keybindings '<file>':
…`, exit 2, nothing opens): invalid JSON, an unknown action, a malformed key
id, or a file that is not a regular file or is over 64 KB. A missing file
means the shipped bindings.

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
| `approvals.fullAccess` | `alt+a` | turn approvals off or on for this session |
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
| `tree.up` | `up` | session tree: previous entry (wraps) |
| `tree.down` | `down` | session tree: next entry (wraps) |
| `tree.pageUp` | `left`, `pageup` | session tree: a page up |
| `tree.pageDown` | `right`, `pagedown` | session tree: a page down |
| `tree.foldOrUp` | `alt+left`, `ctrl+left` | session tree: fold the branch, or go to its start |
| `tree.unfoldOrDown` | `alt+right`, `ctrl+right` | session tree: unfold the branch, or go to the next one |
| `tree.select` | `enter` | session tree: go to the selected entry |
| `tree.close` | `escape` | session tree: clear the search, else close |
| `tree.copy` | `ctrl+x` | session tree: copy the selected entry |
| `tree.label` | `shift+l` | session tree: label the selected entry |
| `tree.labelTime` | `shift+t` | session tree: show when labels were set |
| `tree.filter.default` | `ctrl+d` | session tree: the default view |
| `tree.filter.noTools` | `ctrl+t` | session tree: hide tool results |
| `tree.filter.userOnly` | `ctrl+u` | session tree: prompts only |
| `tree.filter.labeledOnly` | `ctrl+l` | session tree: labelled entries only |
| `tree.filter.all` | `ctrl+a` | session tree: every entry |
| `tree.filter.next` | `ctrl+o` | session tree: the next filter |
| `tree.filter.previous` | `ctrl+shift+o` | session tree: the previous filter |

## See also

- [The TUI](tui.md): the screen, turns, panels and slash commands.
- [Approvals](approvals.md): the approval card and what asks.

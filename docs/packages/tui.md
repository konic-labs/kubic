# `@kubic/tui`

> The interactive terminal UI: layout and views over the presentation
> state.
> Source: `packages/tui/src`.

`@kubic/tui` is presentation only. It renders the [@kubic/core](core.md)
`KubicPresentationState` and holds no runtime authority: it defines no
event vocabulary of its own and never imports host or agent code
(`npm run lint:deps`). Every Pi presentation import goes through
`tui-boundary.ts`, the TUI's counterpart of the agent's Pi boundary. What
a user sees and presses is documented on the [`kubic tui`](../cli/tui.md)
and [keys](../cli/tui-keys.md) pages.

## Entry points

| Entry point | What it holds |
| --- | --- |
| `@kubic/tui/tui-app` | `createTuiApp`: wires the app's controllers (`app/`) over one shared core and routes every key through one table in precedence order |
| `@kubic/tui/tui-boundary` | The only Pi seam: the `pi-tui` components, key parsing and width helpers, each re-export with its justification |
| `@kubic/tui/layout` | The layout root: header, tree, transcript, panel, notice, editor, status line and key-hint row |
| `@kubic/tui/screen` | The alt-screen lifecycle |
| `@kubic/tui/transcript` | The transcript: committed lane entries as cells, plus the streaming draft |
| `@kubic/tui/lane-cells` | Committed lane entries to cells, with every model-supplied text sanitised |
| `@kubic/tui/tree` | The agent tree: the run row and its tool calls, grouped per turn |
| `@kubic/tui/status-bar` | The one-row status line: model, context gauge, cost, journal count, turn state |
| `@kubic/tui/chrome` | The one-row header and the context-aware key-hint row |
| `@kubic/tui/editor-frame` | The framed editor, and the working line above it while a turn runs |
| `@kubic/tui/approval-surface` | The answer seat for the host's approval asks: the queue, the key check, sanitising at ingress |
| `@kubic/tui/keybindings` | The keybinding registry and `~/.kubic/keybindings.json` overrides |
| `@kubic/tui/slash-commands` | The `/`-command registry the palette, the editor and the help read |
| `@kubic/tui/preflight` | The first screen, and the no-key block printed before exit 6 |
| `@kubic/tui/attachments` | Prompt image attachments: the protocol image where the terminal has one, a placeholder row elsewhere |
| `@kubic/tui/theme` | The theme: the shared design tokens bound to the terminal's colour depth |
| `@kubic/tui/ui/palette` | The ^P command palette |
| `@kubic/tui/ui/highlight` | Syntax highlighting for fenced code |
| `@kubic/tui/ui/clipboard` | OSC 52 copies |

The rest of `ui/` is the render kit every surface is drawn with (lines,
frames, badges, gauges, key hints, the picker list, diff blocks); it is
internal to the package.

## Invariants

- **Model output cannot drive the terminal.** `lane-cells.ts` sanitises
  every cell's text: complete ECMA-48 sequences (CSI, OSC, C1, two-byte
  ESC forms) are stripped, carriage-return overwrites collapse to the text
  after the last `\r`, tabs expand by column and the remaining C0/C1
  controls are dropped. Approval asks are sanitised when they arrive.
- **Widths are columns, not code units.** Every width comes from Pi's
  grapheme-aware helpers through `tui-boundary.ts`, never `string.length`.
- **Renders are pure.** Views return strings over a `UiTheme`; at colour
  depth `none` they are plain text, so headless snapshots stay readable.
  The active theme starts at `none`, and only the composition root opts
  into colour after checking the real terminal.
- **A steady frame does no work.** Each transcript cell's markdown and
  finished rows are cached while its text, width and theme are unchanged,
  and a re-applied snapshot keeps every unchanged cell object;
  `transcript-steady.test.ts` counts the helpers a steady frame calls.
- **Esc never quits.** It closes a dropdown or overlay, else interrupts the
  turn. Ctrl-C cancels, clears or arms a quit; Ctrl-D quits on an empty
  draft; plain characters always belong to the editor.

## Neighbours

- Imports: [@kubic/core](core.md) only; Pi through `tui-boundary.ts`.
- Imported by: `apps/kubic`, which composes it with the host.

```text
@kubic/core ──→ @kubic/tui ──→ apps/kubic (composed with host)
      (pi-tui via tui-boundary.ts only)
```

Back to the [docs index](../README.md).

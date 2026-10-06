# Kubic UI design (v1)

The design reference for Kubic's terminal surfaces: the TUI and the CLI's
human-facing output. Tracked by EPIC N
([#442](https://github.com/konic-labs/kubic/issues/442)).

The mockups are plain HTML and CSS. Open [index.html](index.html) in a
browser (no build, no server). Every screen is drawn on a real character
grid — one row is one terminal line and colour is per cell — so what is
drawn can be built one-to-one on pi-tui. Refer to a mockup element by its
note id, for example `01-D` or `06-B`.

| Page | Screen |
| --- | --- |
| [index.html](index.html) | Principles, colour tokens, glyphs, screen list |
| [01-session.html](01-session.html) | Solo session: transcript blocks, tool cards, inline diff, thinking, receipt, editor, status line, key hints; mid-turn state |
| [02-approval.html](02-approval.html) | Inline approval cards: shell command, file edit with diff preview |
| [03-palette.html](03-palette.html) | `^P` command palette and the bare `/model` picker |
| [04-orchestrator.html](04-orchestrator.html) | Orchestrator dashboard |
| [05-welcome.html](05-welcome.html) | First launch preflight; the no-key exit |
| [06-cli.html](06-cli.html) | CLI: help, run, doctor, models, setup, errors |
| [kubic.css](kubic.css) | Tokens and the character-grid rules the mockups use |

## Principles

- **One hot colour.** Konic red marks identity and focus only: the brand
  mark, the editor caret, the selected row, the edge of your own prompt.
  Status uses its own colours.
- **Surfaces, not lines.** Hierarchy comes from three background levels
  and three text levels. Rules are faint; boxes are rare.
- **Every block earns its row.** No permanent banners. Header, status line
  and key hints are one row each; tool output shows the useful slice.
- **Say the state.** Waiting, working, failed and done each have one glyph
  and one colour, used the same way in the TUI, the dashboard and the CLI.
- **Keys follow focus.** The hint row shows only what works right now.
  Esc backs out; it never quits.
- **Plain when piped.** Colour, spinners and boxes are a terminal layer.
  `--json`, pipes and `NO_COLOR` keep the stable text the binary contract
  pins. Root help is the one deliberate exception: it is the same grouped
  text everywhere (plain when piped).

## Colour tokens

One set of roles for every surface (`packages/core/src/ui/`). Values below
are the `dark` built-in (also `default`); `light` uses the same roles and
`terminal` maps the semantic roles onto the terminal's own palette with no
backgrounds.

| Role | Dark | Used for |
| --- | --- | --- |
| `bg0` | `#0a0a0c` | Canvas |
| `bg1` | `#111115` | Header, status line, code blocks |
| `bg2` | `#18181e` | Raised: your prompt, inline code, overlays |
| `bg3` | `#22222a` | Selected row |
| `fg0` | `#ececf1` | Primary text |
| `fg1` | `#a3a3ae` | Secondary text, targets, keys in hints |
| `fg2` | `#6a6a75` | Muted: labels, durations, hint words |
| `fg3` | `#3c3c45` | Faint: rules, gutters, line numbers |
| `accent` | `#ff004d` | Konic red: brand, caret, focus edge, matches |
| `accentBg` | `#2a0612` | Accent surface |
| `ok` / `okBg` | `#5ed68c` / `#0c2416` | Success |
| `warn` / `warnBg` | `#ffb547` / `#2a1d07` | Waiting for you, warnings |
| `err` / `errBg` | `#ff6b5e` / `#2c0d0b` | Failure (always with ✕) |
| `info` | `#7fb4ff` | Links |
| `add` / `addBg` | `#7ee2a0` / `#0e2617` | Diff additions |
| `del` / `delBg` | `#ff8f9c` / `#2d0e15` | Diff removals |
| `addWordBg` / `delWordBg` | `#164a2a` / `#4a1220` | The changed words inside an added / removed diff line |

At 16 colours the `bg0`–`bg2` surfaces drop their background (a 16-colour
grey reads worse than none) and `bg3` selection uses bright black.

## Glyphs

| Glyph | Meaning |
| --- | --- |
| `■` | Brand mark |
| `▌` | Focus edge: your prompt, the selected row or block |
| `◆` | Assistant prose (fg1); waiting for you (warn) |
| `●` | Tool call, coloured by result |
| `○` | Collapsed, queued or not set |
| `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Working (spinner) |
| `⋯` | Thinking, collapsed |
| `✓` `✕` `▲` | ok · failed · warning |
| `│` `└` | Tool-card gutter and footer |
| `┏` `┃` `┗` `━` | Blocking card (approval); `━` also draws gauges and the run timeline |

## Key map (TUI)

| Key | Action |
| --- | --- |
| `⏎` / `⇧⏎`, `^J` | Send / newline |
| `Esc` | Close the open overlay; else interrupt a running turn; else (idle, empty editor) enter block mode. Never quits. |
| `^C` | Interrupt a running turn; else clear the draft; else press twice to quit |
| `^D` | Quit (empty editor) |
| `^P` | Command palette (`^K` stays the editor's kill-to-end-of-line) |
| `^X` | Expand output, diffs and thinking |
| `^O` / `^R` | Diff panel / journal panel |
| `^T` | Tool tree |
| `^G` | Solo ↔ orchestrator |
| `Alt+M` / `Alt+T` | Model picker / cycle thinking (on macOS, Option must send Esc+; `/model` and `^P` always work) |
| `?` | All keys (idle, empty editor) |
| Block mode | `↑↓`/`jk` move, `⏎` view, `y` copy, `Y` copy command, `x` expand, `esc` back |

## Mockup notes → issues

| Notes | Issue |
| --- | --- |
| Tokens, palettes, style engine | [#444](https://github.com/konic-labs/kubic/issues/444) |
| CLI output kit | [#445](https://github.com/konic-labs/kubic/issues/445) |
| 06-A help | [#446](https://github.com/konic-labs/kubic/issues/446) |
| 06-B `kubic run` | [#447](https://github.com/konic-labs/kubic/issues/447) |
| 06-C `kubic doctor` | [#448](https://github.com/konic-labs/kubic/issues/448) |
| 06-D `kubic models`, tables | [#449](https://github.com/konic-labs/kubic/issues/449) |
| 06-F errors | [#450](https://github.com/konic-labs/kubic/issues/450) |
| 06-E setup | [#451](https://github.com/konic-labs/kubic/issues/451) |
| TUI kit (frames, surfaces, badges, gauges, hints, matching) | [#452](https://github.com/konic-labs/kubic/issues/452) |
| 01-A header, 01-L status line, 01-M key hints, `/safety` | [#453](https://github.com/konic-labs/kubic/issues/453) |
| 01-K editor, mid-turn frame, key model | [#454](https://github.com/konic-labs/kubic/issues/454) |
| 01-B prompt, 01-C prose, 01-D tool card, 01-E collapsed read | [#455](https://github.com/konic-labs/kubic/issues/455) |
| 01-G inline diff | [#456](https://github.com/konic-labs/kubic/issues/456) |
| 01-F thinking, 01-J receipt | [#457](https://github.com/konic-labs/kubic/issues/457) |
| 01-I markdown, highlighting, links | [#458](https://github.com/konic-labs/kubic/issues/458) |
| 02-A … 02-E approval cards | [#459](https://github.com/konic-labs/kubic/issues/459) |
| 03-A … 03-C palette | [#460](https://github.com/konic-labs/kubic/issues/460) |
| 03-D, 03-E pickers | [#461](https://github.com/konic-labs/kubic/issues/461) |
| 05-A … 05-F preflight | [#462](https://github.com/konic-labs/kubic/issues/462) |
| Block mode (01-D footer, 01-M) | [#463](https://github.com/konic-labs/kubic/issues/463) |
| 04 data: activity, run phases, diff stats | [#464](https://github.com/konic-labs/kubic/issues/464) |
| 04-A, 04-B, 04-C, 04-E dashboard | [#465](https://github.com/konic-labs/kubic/issues/465) |
| 04-D preview, 04-F dispatch | [#466](https://github.com/konic-labs/kubic/issues/466) |
| 02-D/E/F richer answers (`e`, `A`, `c`) | [#467](https://github.com/konic-labs/kubic/issues/467) |
| Light/terminal themes, 256/16 colour, narrow terminals | [#468](https://github.com/konic-labs/kubic/issues/468) |

## Not designed yet

Light-theme mockups, the diff/journal panels and very narrow terminals
(< 80 columns) are specified in their issues and checked by the quality
matrix (#468) rather than drawn here.

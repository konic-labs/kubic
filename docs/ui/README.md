# Kubic UI design (v1)

The design reference for Kubic's terminal surfaces: the TUI and the CLI's
human-facing output. Tracked.

The mockups are plain HTML and CSS. Open [index.html](index.html) in a
browser (no build, no server). Every screen is drawn on a real character
grid — one row is one terminal line and colour is per cell — so what is
drawn can be built one-to-one on pi-tui. Refer to a mockup element by its
note id, for example `` or ``.

| Page | Screen |
| --- | --- |
| [index.html](index.html) | Principles, colour tokens, glyphs, screen list |
| [01-session.html](01-session.html) | Solo session: transcript blocks, tool cards, inline diff, thinking, receipt, editor, status line, key hints; mid-turn state |
| [02-approval.html](02-approval.html) | Inline approval cards: shell command, file edit with diff preview |
| [03-palette.html](03-palette.html) | `^P` command palette and the bare `/model` picker |
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
  and one colour, used the same way in the TUI and the CLI.
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
| `fg2` | `#6e6e79` | Muted: labels, durations, hint words |
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
| `Alt+M` / `Alt+T` | Model picker / cycle thinking (on macOS, Option must send Esc+; `/model` and `^P` always work) |
| `?` | All keys (idle, empty editor) |
| Block mode | `↑↓`/`jk` move, `⏎` view, `y` copy, `Y` copy command, `x` expand, `esc` back |

## Mockup notes → issues

| Notes | Issue |
| --- | --- |
| Tokens, palettes, style engine | |
| CLI output kit | |
| help | |
| `kubic run` | |
| `kubic doctor` | |
| `kubic models`, tables | |
| errors | |
| setup | |
| TUI kit (frames, surfaces, badges, gauges, hints, matching) | |
| header status line key hints, `/safety` | |
| editor, mid-turn frame, key model | |
| prompt prose tool card collapsed read | |
| inline diff | |
| thinking receipt | |
| markdown, highlighting, links | |
| approval cards | |
| palette | |
| pickers | |
| preflight | |
| Block mode | |
|/E/F richer answers (`e`, `A`, `c`) | |
| Light/terminal themes, 256/16 colour, narrow terminals | |

## Not designed yet

The diff/journal panels and an inline (non-full-screen) TUI variant.

Since drawn or checked: the light theme has its own token set and a light
mock in `index.html` (`:root[data-theme="light"]` / `.theme-light` in
`kubic.css`, the values of `LIGHT_PALETTE`), and the render matrix (`packages/tui/src/ui/matrix.test.ts`, the CLI matrices in core, host and
apps) renders every surface in the dark, light and terminal palettes at
truecolor, 256, 16 and no colour, from 60 to 140 columns: no line overflows,
none leaks a style, and the full-width surfaces paint their whole row. At 16
colours surfaces drop their backgrounds except the selection (bright black);
badges keep inverse video.

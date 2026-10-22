# Contributing

> How to build, test and change Kubic, and the checks every change passes.

Kubic is a model-agnostic terminal coding agent with a VCS-independent
change journal. Kubic has no isolation — never imply otherwise in
code, docs, or CLI text.

## Getting set up

Users install Kubic with `npm install -g kubic`; working on Kubic itself
starts from a clone. Node >= 22.19 is the only requirement:

```sh
npm ci
npm run build                # esbuild bundle -> gitignored dist/kubic.js
./bin/kubic.js --version
npm link                     # optional: `kubic` on your PATH runs this build
```

Kubic runs on the Pi agent harness (`@earendil-works/*` **1.0.2**, exact
pins), installed from npm like every other dependency.

`npm run build` bundles Kubic's own code into one file, `dist/kubic.js`, with
esbuild (`scripts/build.mjs`). Third-party packages stay external, so the
bundle carries only Kubic's code, and a rebuild is byte-equivalent.
`bin/kubic.js` is the committed executable over that output; `npm run kubic --
<args>` and `node dist/kubic.js <args>` run the same binary.

## Where things are

| Path | What it is |
| --- | --- |
| [`bin/kubic.js`](../bin/kubic.js) | The committed `kubic` executable, a wrapper over the build output |
| [`apps/kubic/`](../apps/kubic/) | The composition root: `src/main.ts` wires the host and the TUI, and `test/` holds the end-to-end tests |
| [`packages/`](../packages/) | `core`, `exec`, `agent`, `host`, `trajectory`, `eval` and `tui`, each with a [package page](packages/README.md) |
| [`scripts/`](../scripts/) | The build, the repository gates, kshot and the docs images, each with its own test |
| [`test/`](../test/) | Fixtures every package's tests share: the fake terminal, temp directories and the hermetic environment |
| [`docs/`](README.md) | These pages, and `docs/assets/` for their images |

## Before you push

Three commands cover everything CI runs:

```sh
npm run check                         # every static gate, listed below
npm test                              # the vitest suite: unit and integration tests
npm run build && npm run test:binary  # the built binary's contract and the faux smoke
```

`npm run check` runs, in this order:

```sh
npm run typecheck        # tsc --noEmit: typecheck only, no emit
npm run lint             # biome ci: formatting and lint, exact CI parity
npm run lint:deps        # import rules: package direction, seams, test fixtures
npm run lint:dead        # knip: unused files, exports, dependencies, types
npm run lint:dead:prod   # knip on production code only: test imports count as no use
npm run check:pins       # exact pins on every dependency
npm run docs:check       # no dangling internal doc links; generated config docs current
npm run check:gates      # the repo gates and the scripts' own tests (node --test)
```

`npm run docs:config` regenerates the config docs and `example.toml` from the
config schema. `npm run test:coverage` runs the suite with v8 coverage of the
product sources: the floors in `vitest.config.ts` (statements, branches,
functions, lines) fail a run that drops below them, and the HTML report lands
in the gitignored `coverage/`.

`npm run test:binary` (`scripts/binary-contract.mjs`, then
`scripts/faux-smoke.mjs`) is the install-story gate: with `dist/` built it
asserts the exact `kubic <version> (license: MIT)` line (exit 0), `kubic
doctor` exiting 6 with `FAIL limit:provider-availability (provider-down)`,
and a provider-less `kubic run -p` exiting 6 while still printing the
`session:`/`journal:`/`usage:`/`trajectory:` refs, then drives a full faux
run through the binary. It is hermetic — the probes run under a temp `HOME`
with no `models.json` in the cwd, so no provider and no network.

## Repo scripts

The gates use standard tools where one fits (TypeScript, biome, knip, vitest).
The scripts under `scripts/` cover what those tools cannot, each with its own
`*.test.mjs` beside it:

| Script | Why it exists |
| --- | --- |
| `build.mjs` | Bundles Kubic's own code into `dist/kubic.js` with esbuild. Third-party packages stay external, and a bare import the root manifest does not declare fails the build. |
| `binary-contract.mjs` | Runs the built binary: only the shipped artifact proves its exit codes, its startup output and the purity of its `--json` output. |
| `faux-smoke.mjs` | Drives the built binary through a whole faux-provider run with a tool call. |
| `release-stage.mjs` | Stages the npm package in `release/` (`npm run release:stage`): the bundle, a manifest generated from the root one, and a shrinkwrap resolved from the tested lockfile; then packs it and writes its CycloneDX SBOM beside the tarball. The root manifest stays private. |
| `pack-install-contract.mjs` | Proves the packed release (`npm run release:contract`): its file list, a tarball install that runs, and a registry install that honours the shrinkwrap within the size budget. |
| `dep-lint.mjs` | The import rules: package direction, no relative import across packages, test fixtures only in tests, `node:fs` and `node:child_process` only in `exec`, the two Pi boundary files, host folders through their `index.ts`, and one argv parser. `vi.mock` specifiers count as imports. |
| `check-pinned-deps.mjs` | Every dependency in every manifest is one exact version, no manifest has `overrides` (npm ignores them when someone installs kubic), and every workspace dependency is declared by the root manifest with the same version. `.npmrc` sets `save-exact=true` for new installs; the check catches a hand edit. |
| `check-docs-links.mjs` | Every relative link in `docs/` resolves, with no dependency to install. |
| `gen-config-docs.mjs` | Generates the config key tables and `example.toml` from the config schema; `--check` fails when they are stale. |
| `pi-boundary.test.mjs` | The Pi dependency contract: exact Pi pins, one hoisted copy of each Pi package in the lockfile, and a `JUSTIFICATION:` block on every boundary export. |
| `git-sandbox-gate.test.mjs` | Real-git tests go through the shared sandbox: a direct git spawn reads the developer's own git config. |
| `license.test.mjs` | MIT on every manifest, the NOTICE attributions, and a permissive license for every runtime dependency in the lockfile. |
| `build-contract.test.mjs` | The packaging story: the ESM root manifest, the `kubic` bin wrapper loading `dist/kubic.js`, `dist/` ignored, the Node floor. |
| `kshot/kshot.py` | Screenshots of the real TUI, driven by a scenario (`npm run kshot -- <scenario>`; see [Seeing the TUI](#seeing-the-tui)). Its tests are Python, and `kshot.test.mjs` runs them wherever `python3` is installed. |
| `art/art.py` | Draws the README's brand art: the banner, the facts strip, the closing band and the feature icons (see [Docs images](#docs-images)). Its tests are Python too, run by `art.test.mjs`. |
| `docs-images.mjs` | Regenerates every image under `docs/assets/` (`npm run docs:images`); its test checks that each image there has a generator. |

dependency-cruiser, the standard tool for import rules, cannot parse TypeScript 7 sources,
which is why `dep-lint.mjs` exists.

### Dead-code gate

`npm run lint:dead` runs knip (pinned exactly in `package.json`) with
`knip.jsonc`, which carries the reason for each choice. It reports unused
files, exports, types and dependencies, and unlisted or unresolved imports.

- Entries are `scripts/*.mjs` and `test/*.ts` at the root, and each package's
  and the app's `*.test.ts` files; the app's `src/main.ts` is its entry, and
  `bin/kubic.js` comes from the `bin` field. A test file is an entry, so an
  export that only tests import counts as used.
- `mkfifo` is in `ignoreBinaries`: one exec journal test calls the POSIX
  utility to make a named pipe. It is a system tool, not a dependency.
- `ignoreExportsUsedInFile` is off: an export that only its own module uses is
  reported, so it must be module-private.
- `includeEntryExports` is on for the package and app workspaces (`knip.jsonc`)
  and in `knip.production.jsonc`. Each package's exports map makes its modules
  entry files for knip, and this setting keeps an export that nothing uses
  reported. knip may print an informational `Unused tag` hint for a boundary
  seam; a hint does not fail the gate.

The default gate does **not** report an export that only tests import, and it
does not report a source file that only tests reach. The production gate does
both: `npm run lint:dead:prod` runs knip with `knip.production.jsonc` and
`--production`, which skips the test files, so no test import counts as use,
and `ignoreExportsUsedInFile` is off there too. An export that tests import
while production code uses it only inside its own module (a limit, a pure
helper a test pins directly) is tagged `/** @internal */`: knip skips
`@internal` exports in production mode only, so the default gate still
requires a use, and the tag tells a reader the export is not API. The Pi and
TUI boundary seams that only tests reach are tagged the same way where they
are re-exported.

## Tests

- **Test first.** Write the failing test, watch it fail, then write the
  code. One behaviour per test, real code over mocks.
- **Placement.** A unit test sits beside its module (`foo.ts` and
  `foo.test.ts`). The composition root's integration tests, which drive
  `kubic run`, `kubic tui` and the command front door through the real
  wiring, live in `apps/kubic/test/`, grouped by surface (`run/`, `tui/`,
  `cli/`, `approvals/`, `lane/`, `replay/`, `config/`) and named by the
  behaviour they cover.
- **No network, no paid tokens.** Agent tests use the `faux` provider;
  usage and cost tests use fixture `usage` rows.
- **Hermetic by default.** `test/vitest-setup.ts` runs every test file
  under a fresh temp `HOME` (so `~/.agents/skills`, `~/.pi/agent/skills`
  and `~/.kubic` are empty), with every ambient `KUBIC_*` variable cleared
  and non-loopback TCP connects refused. Loopback is exempt, so a test that
  owns a local server stays hermetic. A test that needs an environment
  variable stubs it with `vi.stubEnv` and restores it in `afterEach`.
- **Clean up.** A test removes every temp dir, environment change and child
  process it creates. `tempDir()` from `test/temp-dir.ts` makes a directory
  that is removed after the current test.
- **Shared fixtures.** A helper two test files need lives in one place: a
  package's `src/test-support/` (for its own tests, or through its exports
  map), `apps/kubic/test/fixtures/` for the integration tests, or the root
  `test/` folder across packages. Test fixtures never ship: a production
  module that imports one fails `npm run lint:deps`.
- **Lanes.** Boot a lane with `bootFauxLane`
  (`packages/agent/src/test-support/lane-harness.ts`): the real `bootLane`
  over in-memory or temp-dir storage. A faux tool round must end with
  `stopReason: 'toolUse'` (`fauxToolUse(...)`), or the tool never runs.
- **The TUI.** Render functions are pure and tested as headless snapshots;
  live frames are read back with `TuiAltScreen.getScreenLines()` over the
  one shared fake terminal, `test/fake-terminal.ts` (`fakeTerminal()`,
  `terminalRig()`). A test never sleeps for a render.
- **Real git.** Tests that run git use the shared sandbox
  (`packages/exec/src/test-support/git-sandbox.ts`); a direct
  `execFileSync('git', …)` in a test fails `npm run check`, whether the call
  spans lines, names a path to git or a variable bound to it.
- **Colour.** Tests never depend on the shell's colour variables:
  `FORCE_COLOR=3`, `FORCE_COLOR=0` and `NO_COLOR=1` runs all pass.

## Seeing the TUI

Headless snapshots pin what a render function returns; kshot shows what a
terminal shows. It runs the built `kubic tui` in a real pseudo-terminal
inside a private tmux server, drives it from a scenario file, and writes
each snapshot as a PNG, an SVG, the plain text and the ANSI:

```sh
npm run kshot -- panels    # builds, then writes .kshot/panels/*.png
```

It needs tmux, and Python 3 with Pillow (`python3 -m pip install Pillow`);
nothing else in the repo depends on them. The app runs on the faux provider
with a fresh `HOME` and a minimal environment, so no key or setting of yours
reaches it. A prompt of the form `faux:tool <name> <json arguments>` makes
the faux model call that tool. A scenario that needs a real-looking session
names a scripted model instead (`model docs-tour.json`): an OpenAI-compatible
endpoint on a loopback port that answers each request with the next reply of
the script, text and tool calls, registered through a `models.json` in the
scenario's `HOME`.

A scenario has one step per line. The full list is at the top of
`scripts/kshot/kshot.py`:

```text
size 120 36
sh printf 'hello\n' > notes.txt
start node $REPO/bin/kubic.js tui
waitfor faux/echo
type faux:tool read {"path":"notes.txt"}
key Enter
waitfor returned
idle
snap after-read
```

`waitfor` waits for text on the screen, `idle` for the screen to hold still,
and `key` takes tmux key names (`Enter`, `Escape`, `C-p`, `M-Down`). `scrub`
replaces text that changes on every run (a clock, a session id, a timing)
before a snapshot is written, and `frame` adds the screen to a film that kshot
writes as `film.svg`, which plays the frames on a loop. The scenarios in
`scripts/kshot/scenarios/` cover the first screen, the palette, the panels
and the confirm dialog, the approval card, the context gauge, the session
tree, and the README's and the docs' images.
A step that fails writes the screen at that moment as `error.png`.

The PNG redraws the terminal's grid with a monospace font (JetBrains Mono,
Menlo, DejaVu Sans Mono or Liberation Mono, or `--font FILE`): layout, glyphs
and colours are exact, while font rendering can differ from your terminal's.
The SVG keeps the text as text in the reader's own monospace font, with each
run stretched to its cells so the columns stay in line.

## Docs images

Every image the README and `docs/` show lives in `docs/assets/`, and one
command makes them all again:

```sh
npm run docs:images    # builds, runs the kshot scenarios, draws the brand art
```

- `docs/assets/tui/` holds the TUI's screens: snaps of the `docs-tour`
  scenario, a session over a small project with a scripted model.
- `docs/assets/readme/session.svg` is the README's film, from the
  `readme-session` scenario.
- The rest of `docs/assets/readme/` is the brand art from `scripts/art/art.py`:
  Konic red on a black field (white when the reader's system is in light
  mode), the TUI's own half-block wordmark and Konic's dither field. Its type
  is outlined from Inter Tight and Space Mono, which the script fetches once
  from the Google Fonts repository at pinned hashes; it needs fontTools
  (`python3 -m pip install fonttools`).

`PYTHON` names another interpreter, such as a virtualenv that has Pillow and
fontTools. `scripts/docs-images.test.mjs` fails on an image that no generator
makes.

A page shows every image with a plain `<img>` or a Markdown image, never a
`<picture>`: GitHub's mobile apps leave a `<picture>` out, image and all, and
`npm run docs:check` fails on one. So the brand art switches between its dark
and light fields inside each SVG, on the reader's system theme
(`prefers-color-scheme`), not on GitHub's.

## Code conventions

- **Erasable-syntax TypeScript only** — no parameter properties, `enum`,
  `namespace`, `import =` / `export =`.
- **Size** — no production module over 600 lines and no function over 150
  (`npm run lint`, through biome's `noExcessiveLinesPerFile` and
  `noExcessiveLinesPerFunction`). An exception is a `biome-ignore` at the
  declaration that says why the code is one unit.
- **Exact pins** — no `^` / `~` on any dependency, and every runtime dependency
  declared by the root `package.json`, the manifest npm installs
  (`npm run check:pins`). The build refuses an import the root does not
  declare.
- **Dependency direction** — packages import "downward" only, and the TUI
  never imports `host` / `agent` implementation; contracts come from
  `core`. A package imports another as `@kubic/<pkg>/<subpath>`, a subpath its
  exports map lists; a relative path into another package fails
  `npm run lint:deps` (see the [package import rule](packages/README.md)).
  Test fixtures (`test-support/` and the root `test/` folder) serve tests
  only: a production module that imports one fails it too.
- **The Pi boundary** — only `packages/agent/src/pi-boundary.ts` and
  `packages/tui/src/tui-boundary.ts` import `@earendil-works/*`. Every
  re-export carries a `JUSTIFICATION:` block naming the seam, its users
  and why Kubic cannot do without it (`scripts/pi-boundary.test.mjs`), and
  CODEOWNERS puts every change to `pi-boundary.ts` up for maintainer
  review. The
  runtime packages are `pi-durable` (the harness, conversations, durable
  tasks, documents, the extension registry), `pi-ai` (the model layer)
  and `chord` (`Context`); `pi-tui` is presentation only.
- **Exactly one copy of each `@earendil-works/*` package** in
  `package-lock.json` and `node_modules`. A nested duplicate keeps vitest
  green but breaks the built binary; after a Pi bump run `npm dedupe`,
  then `npm ci`.
- **CLI commands** — commander is the only argv parser; see
  [contributing-cli.md](contributing-cli.md).

## Commits and docs

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary` — imperative, lower-case, no trailing period
(`feat(journal): …`, `fix(agent): …`, `docs(cli): …`). Types are `feat`,
`fix`, `refactor`, `perf`, `test`, `docs`, `style`, `chore`, `build`,
`ci`; a breaking change uses `type(scope)!:` and a `BREAKING CHANGE:`
footer.

A behaviour change ships its docs page in the same commit, and
`npm run docs:check` must pass. Configuration keys are declared once, in
`packages/host/src/config/schema.ts`: the parser's checks, the runtime's
effect rows, `example.toml` and the key sections in
[configuration.md](cli/configuration.md) all derive from it. After changing a
key, run `npm run docs:config` to regenerate the docs and the example. The
area map lives on the [docs index](README.md).

## Docs style

The docs are for the person using Kubic, so they say what Kubic does and how
to use it, plainly.

- **Voice.** Present tense and active voice, in short sentences. Describe the
  behaviour as it is now: no history ("previously", "used to", "was
  removed"), and no tracker references (issue numbers, design sections, epic
  or wave names).
- **One home per fact.** A guide shows how to do something; a reference lists
  every option. Link to the other page rather than repeat it:
  [the TUI](cli/tui.md) is the guide and [TUI keys](cli/tui-keys.md) the
  reference.
- **Every page** opens with its title and one `>` line that says what it
  covers, uses `##` for sections and `###` within them, and ends with
  `## See also` links.
- **Terms.** *Agent* is what does the work; a *session* is the durable
  conversation it works in; a *branch* is one line of a session (`/tree`); a
  *fork* copies a session into a new one; the *journal* records every change,
  and *undo* restores from it. *Approvals off* is the posture in which
  challenged calls run without asking; write *full access* only when quoting
  the CLI. *Lane* is an internal word: it belongs on the package and
  architecture pages, not in the user docs.
- **Keys** are written `Ctrl+O`, `Alt+M`, `Shift+Enter`, `Esc`, `Enter` and
  `Tab`. Quote the TUI's own hint text as it appears (`^O review diff`).
- **Commands.** Examples write `kubic`, the command an install puts on the
  `PATH`; the [docs index](README.md) says so once. Show output where it helps, and
  label sample output as an example.
- **Tables or sections.** A table suits short, parallel facts: a flag and one
  line. When a cell needs more than a sentence or two, keep a one-line summary
  in the table and give the detail a section of its own. `npm run docs:check`
  fails on a cell over 300 characters, and on a row cut off from its table.
- **No volatile numbers.** Timings, check counts and sizes change from run to
  run: leave them out, or mark the output they appear in as an example.
- **Screenshots** go where a screen says more than the text. The TUI's come
  from kshot scenarios and the brand art from `scripts/art/art.py`, all
  remade by `npm run docs:images` (see [docs images](#docs-images)). Every
  image has alt text that says what it shows (`alt=""` for a decorative one),
  stays under 300 KB, is used by some page, and is never in a `<picture>`
  ([docs images](#docs-images)); `npm run docs:check` checks all four.
- **No isolation.** Kubic has none: never imply otherwise.

## CI

A push runs the `test` job: `npm run check` first (once, on Node 22: the
gates do not depend on the Node version), then `npm audit --omit=dev
--audit-level=high`, the suite (with coverage on the Node 22 leg), the build
and `npm run test:binary`. It runs on Node 22 (the lowest supported) on every ref and on
Node 22 and 24 on `main`. After it, the `pack-contract` job stages, packs,
installs and runs the npm package on Linux and macOS with Node 22.19.0 and
24 (`npm run release:stage`, then `npm run release:contract`; its registry
install uses the network). A newer push cancels the older run of the same
ref; `main` is keyed by commit and never cancelled. Workflow permissions
are read-only.

### Supply chain

- **Updates.** Dependabot (`.github/dependabot.yml`) proposes updates weekly
  for the npm dependencies and for the GitHub Actions the workflows use. The
  proposals keep the exact pins, and the `@earendil-works/*` packages arrive
  as one grouped update, since they ship as a set. A Pi bump that leaves two
  copies of a Pi package in the lockfile fails `npm run check:gates`; run
  `npm dedupe` on its branch.
- **Advisories.** CI runs `npm audit --omit=dev --audit-level=high`: a known
  high or critical advisory in a production dependency fails the run. Run it
  locally the same way; dev-only advisories do not fail it.
- **SBOM.** `npm run release:stage` writes `release/kubic-<version>.cdx.json`
  beside the tarball: a CycloneDX SBOM of the shipped production tree,
  resolved from the shrinkwrap without network access. Staging fails when the
  SBOM misses a package the shrinkwrap pins.

Back to the [docs index](README.md).

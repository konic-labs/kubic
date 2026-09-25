# skills/

First-party skill bundles (issue #80; EPIC D scaffold §64). Each bundle
is a directory with a `manifest.json` (data, validated through the
first-party trust gates at startup — never executed) plus a `SKILL.md`
describing it:

- `budget/` — the `kubic/budget` bundle: the agents budget surface
  (`budget/limits`) on the public loader path. It loads at startup on the
  lane boots (`run`, `tui`, `orchestrate`) and on `kubic doctor`, all
  through the same loader. Removing it fails closed everywhere: the lanes
  refuse to start (`ExtensionStartupError`), and `doctor` prints the
  matching `FAIL extension:bundle` line.

Third-party/MCP loading is out of scope (Phase 4 per #58 — requests
are refused). Bundle wiring lives in `packages/extensions/src` (see
`startup.ts` and the `@kubic/extensions` docs).

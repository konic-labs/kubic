# CLI & operations

> Owner: issue [#64](https://github.com/konic-labs/kubic/issues/64).
> Behaviour operators see; package internals live on the
> [packages pages](../packages/README.md).

Commands operators run. Solo mode has no isolation — docs never imply
otherwise.

**Every command answers `--help`** (or `-h`) with commander's generated help and
exit 0 — one convention, applied before any argv validation, and the root
dispatcher follows it too:
`kubic --help` prints the top-level command listing (exit 0) while a bare
`kubic` prints the identical listing and exits 1 — usage-on-no-args is the
deliberate POSIX posture. Usage errors keep their own exit codes.

**Unexpected command failures are one named line.** An error Kubic did not
shape while a command runs (inside the dispatcher's `main()`) prints
`error: <message>` on stderr and exits 1; the full stack is opt-in with
`KUBIC_DEBUG=1`. That catch-all covers command failures only — a build-output
module that fails while it evaluates at launch is not caught: it prints a raw
stack and exits 1, because the launcher names only a missing build output. The
launcher also refuses runtimes below Node 22.19 by name — `kubic: node >=
22.19 required (running <version>) — see the README install section` — before
it loads anything. See [doctor and debug](doctor-and-debug.md).

## Install and build

A fresh clone plus Node >= 22.19 is enough for a working `kubic` binary
(the launcher enforces that floor and names it when refused) — the exact
commands live in the
[README install section](../../README.md#install). `npm run build` emits
runnable JS to gitignored `dist/` (tsc via `tsconfig.build.json`, no
hand-rolled flags); `./bin/kubic.js` is the committed executable over that
output. All command examples below assume the built binary (`./bin/kubic.js
…`, equivalently `npm run kubic -- …`). Rebuilding is byte-equivalent.

- [commands.md](commands.md) — every `kubic` command and flag
- [exit-codes.md](exit-codes.md) — exit-code table
- [tools.md](tools.md) — the fifteen tools the model calls: argument contract and result shapes
- [configuration.md](configuration.md) — config precedence and secrets
- [trust.md](trust.md) — `kubic trust` and the project-trust store
- [doctor-and-debug.md](doctor-and-debug.md) — `kubic doctor` diagnostics
- [skills.md](skills.md) — `kubic skills`: which skills loaded and why any were left out

Back to the [docs index](../README.md).

# CLI & operations

> Owner: issue [#64](https://github.com/konic-labs/kubic/issues/64).
> Behaviour operators see; package internals live on the
> [packages pages](../packages/README.md).

Commands operators run. Solo mode has no isolation — docs never imply
otherwise.

**Every command answers `--help`** (or `-h`) with its own usage line and exit 0 —
one convention, applied before any argv validation
(`packages/core/src/cli-help.ts`), and the root dispatcher follows it too:
`kubic --help` prints the top-level command listing (exit 0) while a bare
`kubic` prints the identical listing and exits 1 — usage-on-no-args is the
deliberate POSIX posture. Usage errors keep their own exit codes.

## Install and build

A fresh clone plus Node >= 22.19 is enough for a working `kubic` binary —
the exact commands live in the
[README install section](../../README.md#install). `npm run build` emits
runnable JS to gitignored `dist/` (tsc via `tsconfig.build.json`, no
hand-rolled flags); `./bin/kubic.js` is the committed executable over that
output. All command examples below assume the built binary (`./bin/kubic.js
…`, equivalently `npm run kubic -- …`). Rebuilding is byte-equivalent.

- [commands.md](commands.md) — every `kubic` command and flag
- [exit-codes.md](exit-codes.md) — exit-code table
- [configuration.md](configuration.md) — config precedence and secrets
- [doctor-and-debug.md](doctor-and-debug.md) — `kubic doctor` diagnostics

Back to the [docs index](../README.md).

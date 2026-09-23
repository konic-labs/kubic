# CLI & operations

> Owner: issue [#64](https://github.com/konic-labs/kubic/issues/64).
> Behaviour operators see; package internals live on the
> [packages pages](../packages/README.md).

Commands operators run. Solo mode has no isolation — docs never imply
otherwise.

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

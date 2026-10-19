# `@kubic/exec`

> The execution environment: the only package that touches `node:fs` and
> `node:child_process`.
> Source: `packages/exec/src`.

`@kubic/exec` is the seam every tool runs through. No other package
imports `node:fs` or `node:child_process` (`npm run lint:deps` refuses it;
test scaffolding is exempt). It also owns the change journal behind
`kubic diff` and `kubic undo`. Kubic has no isolation: confinement here is
a cwd guardrail against accidental escapes, not a sandbox boundary.

## Entry points

| Entry point | What it holds |
| --- | --- |
| `@kubic/exec/env` | The execution seam: `ExecutionEnv` (cwd, file system, shell, provenance), its Node bindings, and the tool process environment (`toolSpawnEnv`) |
| `@kubic/exec/journal` | The change journal: the store, blobs and retention, the boot baseline and end-of-run sweep, restore and undo, diff and status, and git HEAD state |
| `@kubic/exec/file-bridge` | The file bridge the agent and host read and write their state through, with durable appends and creation modes |
| `@kubic/exec/lock-file` | The lock-file primitives behind the session lock and the journal's mutation lock (`withFileLocked`), and the private-state mode helpers |
| `@kubic/exec/ignore` | The `.gitignore`-subset matcher the journal walk and the agent's find and grep share |
| `@kubic/exec/runtime-exclude` | The entries `kubic run` and `kubic tui` keep in a repo's `.git/info/exclude` |
| `@kubic/exec/read-roots` | Read-only roots outside the cwd, for skills advertised by absolute path |
| `@kubic/exec/git-clean` | A synchronous git-cleanliness probe for the composition root |
| `@kubic/exec/secret-runner` | Runs `!command` secret references |
| `@kubic/exec/stdin` | Reads stdin text |
| `@kubic/exec/test-support/fake-env` | `FakeExecutionEnv`: an in-memory environment whose shell answers only scripted argv |
| `@kubic/exec/test-support/env-fakes` | An in-memory checkpoint store and `argvKey` |
| `@kubic/exec/test-support/git-sandbox` | The shared sandbox every test that runs real git uses |

## Invariants

- **Confinement is a guardrail, not a sandbox.** `confine()` is lexical:
  it stops `..` and absolute escapes, not symlinks. The write path also
  resolves the real target and refuses one outside the workspace.
- **A killed process cannot hang a wait.** `ProcessHandle.kill()` signals
  the whole process group with SIGTERM, then SIGKILL after a grace period
  (2 s by default).
- **Tool processes get an allowlisted environment** (`toolSpawnEnv`); see
  [tool process environment](../architecture/journal-and-safety.md#tool-process-environment).
- **The journal is durable before it says so.** Blobs are flushed before
  the index line that references them, an append is flushed before it
  returns, and a torn tail is repaired rather than glued to the next
  entry. The full protocol, locking and undo records are in the
  [journal README](../../packages/exec/src/journal/README.md).
- **State is private.** Journal and session-state directories are created
  `0700` and their files `0600`; a mode applies only where a path is
  created, and a restore keeps the target's own mode. A directory the
  bridge creates for a file takes the file's mode with the search bit
  added wherever it can be read, so a `0600` file's new parent is `0700`.
- **The fake shell is strict.** `FakeExecutionEnv` throws on an argv with
  no scripted answer unless a test opts out with
  `{ allowUnscripted: true }`, and scripts can match the exact argv array
  (`argvKey`).

## Neighbours

- Imports: [@kubic/core](core.md) only.
- Imported by: [@kubic/agent](agent.md) (the tools and the session store)
  and [@kubic/host](host.md) (the journal commands and state reads).

```text
@kubic/core
    ↑
@kubic/exec           ← sole node:fs/child_process owner
    ↑         ↑
 agent      host
```

Back to the [docs index](../README.md).

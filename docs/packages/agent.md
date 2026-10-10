# `@kubic/agent`

> The agent runtime: the lane, tools, sessions, compaction and the Pi seam.
> Source: `packages/agent/src`.

`@kubic/agent` runs the model. It boots a lane (one pi-durable harness
over one session), adapts Kubic's operations into the tools the model
calls, stores sessions, compacts context and classifies failures. Every
Pi import goes through `src/pi-boundary.ts`, and the pi-boundary gate
fails a re-export that carries no `JUSTIFICATION:` block. `CODEOWNERS`
puts every change to that file in front of a maintainer. What each tool
accepts, returns and bounds is on the [tools page](../cli/tools.md).

## Entry points

| Entry point | What it holds |
| --- | --- |
| `@kubic/agent/pi-boundary` | The only Pi seam: every `@earendil-works/*` symbol the package uses |
| `@kubic/agent/lane/boot` | `bootLane`: the harness over a session, the tool registry and the extensions, installed `kubic.policy` → `kubic.spans` → `kubic` (install order is hook order) |
| `@kubic/agent/lane/turn` | One turn, `conversation.submit()` → `submission.wait()`, with one compact-and-retry on context overflow |
| `@kubic/agent/lane/events` | Lane events relayed from pi-durable's committed watch |
| `@kubic/agent/lane/settle` | A settled submission mapped to Kubic's result errors and failure codes |
| `@kubic/agent/lane/failures` | The failure taxonomy and the retry chooser |
| `@kubic/agent/lane/pending` | Settling a turn a crashed process left open |
| `@kubic/agent/lane/abort` | Aborting a lane and killing the processes its calls started |
| `@kubic/agent/lane/interceptors` | The hooks that run before every tool call: confinement, destructive and network commands, approvals, redaction |
| `@kubic/agent/lane/policy` | Tool policy enforcement |
| `@kubic/agent/lane/wrap` | Tool-wrap composition: permission checks and telemetry |
| `@kubic/agent/lane/session-store` | Session storage: create, attach, fork, list, and the session lock |
| `@kubic/agent/lane/session-fs` | Pi's `FileSystem` over the exec file bridge |
| `@kubic/agent/lane/transcript` | The one adapter from durable entries to Kubic's transcript items |
| `@kubic/agent/compaction` | Kubic's compaction policy on pi-durable's mechanism, and `/compact` |
| `@kubic/agent/model-select` | Model selection, one-way escalation and the thinking clamp |
| `@kubic/agent/models-config` | Custom and local providers from `models.json` |
| `@kubic/agent/stream-options` | Request options per model and role |
| `@kubic/agent/prompts` | Cache-preserving system prompt assembly and per-task model pins |
| `@kubic/agent/permissions` | The permission classes and the tool set they allow |
| `@kubic/agent/skills` | The skills loader: discovery, gating and prompt rendering |
| `@kubic/agent/ops/registry` | The operation registry: each tool's schema, validation and call path |
| `@kubic/agent/ops/types` | The operation types and error codes |
| `@kubic/agent/ops/git` | Structured git operations |
| `@kubic/agent/ops/walk` | The recursive walk `find` and `grep` share |
| `@kubic/agent/ops/display-diff` | The display record of a file change |
| `@kubic/agent/ops/memos` | Memo accessors for Kubic invocations |
| `@kubic/agent/test-support/lane-harness` | `bootFauxLane` and the helpers tests drive a real lane with |
| `@kubic/agent/test-support/models-fixtures` | `models.json` fixtures |

## Invariants

- **The session lock is the only guard around a storage.** pi-durable owns
  one storage per process and does no cross-process locking, so every open
  happens with `lock.json` held (an `O_EXCL` create). A lock is stale only
  when its holder process is gone or its recorded start time moved (a
  reused pid); age alone never makes it stale, a lost takeover race is a
  `SessionLockError`, and a release removes only a lock this process
  owns. A harness takes the storage with `session.adopt()`, so a racing
  `release()` cannot close it underneath. Local filesystems only.
- **Listing never opens a storage.** `listSessions` and the overlap probe
  read each session's small `session.json` header, written from the
  session document and re-synced on attach. A folder without
  `main.jsonl` is not a session, and a session id is a plain path segment
  (`[A-Za-z0-9_-]`), refused before any path join.
- **Session bytes cross the I/O seam.** The storage is opened over the
  exec file bridge, so file modes (`0700` directories, `0600` files) and
  secret scrubbing apply to the session JSONL. Session JSONL is not
  fsynced; the change journal is the store that is.
- **Every transcript reader goes through one adapter**
  (`lane/transcript.ts`). `readSessionEntries` reads a session without a
  harness, a model layer or a write.
- **A lane event snapshot replaces; it never appends.** One
  `subscribeLaneEvents` per conversation relays the committed watch; the
  attach, late-join and overflow paths send a snapshot that replaces the
  consumer's state.
- **Retries are bounded and mostly not Kubic's.** A transient model
  failure is retried by the harness's durable generation retry; the
  chooser adds a different tool or compact-then-retry, and abandons
  `run_limit` and approval denials. A stronger model or a fresh session is
  the operator's call, never automatic. The failure codes are pinned equal
  to the [trajectory](trajectory.md) snapshot.
- **Replay belongs to pi-durable.** An operation's `replay: 'never' |
  'safe'` maps to pi-durable's `'unsafe' | 'safe'`; after a crash only a
  call both sides mark safe re-runs, and an interrupted unsafe call
  settles as an error. Kubic keeps no replay kernel of its own.
- **Permission classes shape the tool set; they are not a boundary.** A
  tool list that contradicts the classes, or classes that need a tool the
  lane did not register, are refused by name, never silently narrowed or
  widened.

| Class | Levels | Default |
| --- | --- | --- |
| `filesystem` | `none`, `read`, `workspace-write`, `full` | `workspace-write` |
| `shell` | `false`, `read-only-allowlist`, `true` | `true` |
| `network` | `none`, `allowlist`, `full` | `none` |
| `git` | `false`, `workspace`, `full` | `workspace` |
| `credentials` | `none`, `allowlist` | `none` |

Skills are local Markdown only: no fetcher, no installer, no network
([skills](../cli/skills.md)).

## Neighbours

- Imports: [@kubic/core](core.md) and [@kubic/exec](exec.md); never
  host, tui, trajectory or eval.
- Imported by: [@kubic/host](host.md) and the composition root.

```text
core + exec ──→ @kubic/agent ──→ host
                     ↑
           pi-boundary.ts (the Pi seam)
```

Back to the [docs index](../README.md).

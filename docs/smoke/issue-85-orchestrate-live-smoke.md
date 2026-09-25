# Live orchestrator smoke — issue #85

First `kubic orchestrate` run that reaches settlement: worker sessions are
now created by the manager before the child spawns, so the child's attach
succeeds. Scratch-only: nothing outside the scratch dir was touched.

- Date: 2026-09-25. Binary: `bin/kubic.js` on repo build (`npm run build`
  clean at `feat/issue-85-worker-session`).
- Provider: local Ollama at `http://127.0.0.1:11434/v1` via `models.json`
  (`openai-completions`, provider id `local`, model `qwen3.5:0.8b` —
  tools-capable, zero paid tokens).
- Hermetic env: `HOME=<scratch>/home` (worker sessions land under
  `<scratch>/home/.kubic/sessions`), `KUBIC_SMOKE_KEY=<redacted-dummy>`
  (Ollama ignores it; value was never a real secret).
- Scratch dir itself is untracked cache (not in the repo); `models.json`
  held only the local endpoint above — no secrets.

## 1. Settled orchestrate run in the issue's exact repro shape (exit 0)

Fresh `git init` scratch repo, **no** `.gitignore` (the shape the issue
reproduced the failure in), with the local provider configured:

```console
$ kubic orchestrate -p "Reply with exactly: WORKER-OK. Do not call any tools. Do not write any files." \
    --agents worker-1 --yes --session smoke85
session: created 'smoke85-worker-1' for worker 'worker-1' (cwd <scratch>/repo/.kubic/wt/worker-1)
spawn: worker 'worker-1' in <scratch>/repo/.kubic/wt/worker-1
merged: worker-1 (branch kubic/worker-1)
reaped: worker-1 (worktree + branch retained)
session: smoke85
worker: worker-1 branch=kubic/worker-1 hunks=0
merge order: worker-1
attribution: worker-1=0 hunk(s)
merged: worker-1
reaped: worker-1
result: orchestrated 1 worker(s), merged 1
exit: 0
```

The worker's session really ran inference in its own worktree — 22,393-byte
transcript at `<scratch>/home/.kubic/sessions/--…wt-worker-1--/`, header:

```json
{"v":4,"kind":"header","id":"smoke85-worker-1","storageVersion":1,
 "createdAt":1790330355718,
 "cwd":"<scratch>/repo/.kubic/wt/worker-1"}
```

`merged:`/`result:` reached for worker-1 (acceptance criterion 1). Before
the fix this same invocation failed on the first worker with
`worker run exited 5: unknown session: smoke85-worker-1`.

## 2. Two-worker default demo (exit 0)

Default agent set (`worker-1,worker-2`), no `--agents`:

```console
$ kubic orchestrate -p "Reply with exactly: WORKER-OK. Do not call any tools." --yes --session two
session: created 'two-worker-1' for worker 'worker-1' (cwd <scratch>/repo-two/.kubic/wt/worker-1)
…
session: created 'two-worker-2' for worker 'worker-2' (cwd <scratch>/repo-two/.kubic/wt/worker-2)
…
merge order: worker-1 -> worker-2
merged: worker-1
merged: worker-2
result: orchestrated 2 worker(s), merged 2
exit: 0
```

Worker transcripts persisted under the sessions root — proof the children
really attached and ran inference in their own sessions:

```
<scratch>/home/.kubic/sessions/--…repo-two-.kubic-wt-worker-1--/….jsonl   75,536 bytes / 261 lines
<scratch>/home/.kubic/sessions/--…repo-two-.kubic-wt-worker-2--/….jsonl   18,920 bytes /  56 lines
```

## 3. Worker-session cwd is the worktree (acceptance criterion 5, live)

Read back from the store after section 1's run (same header shown above):
`cwd` is `<scratch>/repo/.kubic/wt/worker-1` — the worker's worktree, not
the parent checkout. The parent repo's `.kubic/` holds only `orchestrator/`
and `wt/`; there is no `sessions/` dir there. Worker journals/session state
land with the worker.

Pinned by regression test
(`packages/host/src/orchestrate-prod-path.test.ts`, "creates the worker
session with the worktree cwd so the child can attach").

## 4. No provider → provider boundary, never `unknown session` (exit 1)

Same command in a scratch repo with no `models.json`:

```console
$ kubic orchestrate -p "say hi" --agents worker-1 --yes --session noprov
session: created 'noprov-worker-1' for worker 'worker-1' (cwd <scratch>/repo-noprov/.kubic/wt/worker-1)
reaped: worker-1 (worktree + branch retained)
session: noprov
error: worker 'worker-1' failed: worker run exited 6: no models available: register a provider first code=worker_failed
exit: 1
```

The child reaches the provider probe and exits **6**
(`provider_probe_failed`) — the session creation succeeded, so the failure
is at the provider boundary.

## 5. Stale branch / no worktree (exit 1, named code) (acceptance criterion 4)

`git branch kubic/worker-1` survives while `.kubic/wt/worker-1` does not —
the shape left by `rm -rf .kubic && git worktree prune`:

```console
$ kubic orchestrate -p "say hi" --agents worker-1 --yes --session stale
session: stale
error: spawn failed for worker 'worker-1': worktree <scratch>/repo-stale/.kubic/wt/worker-1 is gone but branch kubic/worker-1 exists — recreate it with `kubic orchestrate` in a clean checkout or remove the branch first (nothing was spawned) code=spawn_failed
exit: 1
```

No raw `ENOENT` stack trace, no `node:events` crash — a named
`spawn_failed` code on a normal exit path.

## Gaps found (none hidden)

- **G3 — `.kubic/` dirtied the tree in a repo with no ignore entry.** The
  orchestrator writes `wt/` and `orchestrator/` under `<root>/.kubic/`, and
  the design has that dir gitignored (§35) — but nothing wrote the ignore
  entry, so a fresh `git init` repo showed `?? .kubic/` and the pre-merge
  guard refused every merge (`working tree not clean`). Fixed in this issue:
  the orchestrate path now ships the runtime ignore rules into the repo-local
  exclude file via issue #91's `ensureRuntimeExcludeRules` (the same
  mechanism `kubic run` uses), so `.kubic/` runtime state stays invisible
  while `.kubic/roles/*.md` and `config.toml` stay committable. An earlier
  revision of this fix wrote a self-ignoring `<root>/.kubic/.gitignore`
  containing `*`; that was replaced on `main` because it also ignored the
  committable roles (verified: `git add .kubic/roles/new-role.md` refused
  with *"The following paths are ignored by one of your .gitignore files"*,
  contradicting issue #91 criterion 2).

## Secret sweep

`grep` over the tree (excluding `pi/`, `node_modules`, `dist`) for
`sk-`, `api[_-]?key\s*[:=]`, `ghp_`, `AKIA`, `BEGIN .*PRIVATE KEY`,
`xoxb-`: no live secret material. Committed tests use faux fixtures only;
the smoke key above was a throwaway dummy local to the scratch dir.

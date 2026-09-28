# Tools the model calls

> Owner: issue [#168](https://github.com/konic-labs/kubic/issues/168).
> Source of truth: `OPERATION_PARAMETERS` in
> `packages/worker/src/ops/registry.ts` (schemas) and each operation's
> `validateArgs` (the authoritative check).

Every solo lane (`kubic run`, `kubic tui`, every orchestrator worker)
registers the same fifteen tools, narrowed only by permission classes and
`--role`. Solo mode has no isolation: these tools act on the real
workspace.

## Argument contract

- **Every tool publishes its real parameter schema** — argument names,
  types, which are required, and a one-line description per argument. The
  model never has to guess `file_path` versus `path`.
- **Objects are closed.** An argument a tool does not declare is refused by
  name (`<tool>: unknown argument "<key>" (strict sampling)`), never silently
  ignored. Pi validates each call against the schema before it runs; a
  schema failure comes back to the model as a `Validation failed for tool
  …` message listing each problem.
- **Constrained sampling is requested, not required:** every tool declares
  `constrainedSampling: { type: "json_schema", strict: "prefer" }`, so a
  provider that can enforce the schema at the API level does, and one that
  cannot still gets the call. Kubic's own validators stay authoritative:
  they also check what a schema cannot express (a compilable regex, a ref or
  range that does not start with `-`, a path that stays in the workspace).
- **Units:** `bash.timeout` is in **seconds**; `read.offset` is **1-indexed**.

| Tool | Arguments (`?` = optional) | Notes |
| --- | --- | --- |
| `read` | `path`, `offset?` (≥ 1, default 1), `limit?` (≥ 1, default and cap 2000) | At most 8 MiB scanned; at most 51200 bytes returned. |
| `ls` | `path?` (default `.`) | One directory, not recursive. |
| `find` | `root?`, `nameContains?`, `type?` (`"file"` \| `"dir"`), `maxResults?` (default 100) | Recursive. |
| `grep` | `pattern` (JavaScript regex), `root?`, `include?`, `maxMatches?` (default 100) | `include` is a path **substring**, not a glob. |
| `write` | `path`, `content` | Whole-file, atomic (tmp + rename). |
| `edit` | `path`, `oldText`, `newText`, `expectCount?` (default 1) | `oldText` must occur exactly `expectCount` times, else `no_match` / `ambiguous_match`; over 8 MiB is refused. |
| `bash` | `command`, `timeout?` (seconds, > 0) | bash, else sh; each stream keeps its last 64 KiB. |
| `git_status` | — | |
| `git_diff` | `staged?`, `range?`, `path?` | |
| `git_log` | `max?` (default 20, cap 100), `path?` | |
| `git_show` | `ref` | |
| `git_stage` | `paths` (non-empty array) | Explicit paths only, never `-A`. |
| `git_commit` | `message`, `amend?` | |
| `git_branch` | `create?` | Omit to list; no checkout. |
| `git_checkpoint` | `message` | `git stash create`; the tree is untouched. |

## Result shapes

`read`, `grep` and `bash` answer in **plain text under a one-line header**,
so file content arrives as raw lines (no `\n` or `\"` escapes to undo before
an exact-match `edit`):

```text
[read src/app.ts: lines 1-120 of 480; more: offset=121]
<raw lines 1-120>

[read min.js: line 1 is 3145728B — above the 51200B output cap; read it with bash: sed -n '1p' < 'min.js' | head -c 51200]

[read logo.png: binary file (4096B, invalid UTF-8) — read serves text only; use bash for byte-level inspection]

[grep /TODO/: 2 matches]
src/a.ts:14: // TODO tighten
src/b.ts:3: // TODO remove

[bash exit 1 (bash)]
--- stdout ---
<raw stdout>
--- stderr ---
<raw stderr>
```

- `read` says `of at least N` when the scan stopped early (N is then a
  lower bound), `more: offset=K` whenever lines remain past the window,
  `empty (0 lines)` for an empty file, and `no lines at offset K` when the
  8 MiB scan budget stopped before the offset.
- `read` caps the returned content at **51200 bytes**. A window past the
  cap keeps the lines that fit and says `output clipped at 51200B`; a line
  that alone exceeds the cap is left out whole (never a partial line that
  an exact-match `edit` could half-copy) with a `line K is NB — above the
  51200B output cap; read it with bash: …` notice (the path single-quoted
  in the suggested command, and `; more: offset=K+1` when further lines
  exist); an offset past the last line is named `offset K is past the last
  line (N lines total)`; and a binary file — NUL byte or invalid UTF-8 in
  the first chunk — is refused with `binary file (NB, <reason>) — …` and
  empty content.
- `grep` adds `, truncated (narrow pattern, root or include)` at the match
  cap; `bash` adds `, timed out`, `, aborted` or `, output truncated`, and
  `(no output)` when both streams are empty.
- Every other tool returns its structured result as JSON.
- A refused call is one line: `error <code>: <message>` — the codes are
  `invalid_args`, `not_found`, `is_directory`, `permission_denied`,
  `no_match`, `ambiguous_match`, `file_too_large`, `journal_failed`,
  `not_a_repo`, `tool_failed` (and `unknown_tool` / `internal`).

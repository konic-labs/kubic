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
| `find` | `root?`, `nameContains?`, `type?` (`"file"` \| `"dir"`), `maxResults?` (default 100) | Recursive; see [Search walk](#search-walk-find-and-grep). |
| `grep` | `pattern` (JavaScript regex), `root?`, `include?`, `maxMatches?` (default 100) | `include` is a path **substring**, not a glob; same [walk](#search-walk-find-and-grep) as `find`; matching lines are clipped at 500 chars and files that are binary or over 8 MiB are skipped and counted (see [Grep bounds](#grep-bounds)). |
| `write` | `path`, `content` | Whole-file, atomic (tmp + rename); a symlinked `path` is written through to its target, so the link survives (see [Symlinked writes](#symlinked-writes)); an existing file above 8 MiB is journaled hash-only, so `undo` reports that step non-reversible. |
| `edit` | `path`, `oldText`, `newText`, `expectCount?` (default 1) | `oldText` must occur exactly `expectCount` times, else `no_match` / `ambiguous_match`; over 8 MiB is refused; writes through a symlink like `write`; matching happens on LF-normalized text with the BOM stripped, and the file keeps its own line ending and BOM (see [Line endings and BOM](#line-endings-and-bom)). |
| `bash` | `command`, `timeout?` (seconds, > 0) | bash, else sh; each stream keeps its last 64 KiB. Default timeout 120 s, at most 600 s; see [Bash limits](#bash-limits). |
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
- `grep` adds `, truncated (narrow pattern, root or include)` when a cap
  stopped it, followed by `: <notice>` naming the cap — for example
  `walk entry cap 10000 reached while listing src/gen; results may be
  incomplete`, `walk depth cap 100 reached at <dir>; results may be
  incomplete`, `result cap 100 reached (maxMatches); results may be
  incomplete`, or `output cap 51200B reached; results may be incomplete`.
  `find` returns its structured result as JSON with the same
  `truncated` and `notice` fields. `bash` adds `, timed out`, `, aborted` or
  `, output truncated`, and `(no output)` when both streams are empty.
- `grep`'s header also names the two things a model must not misread: the
  `lines clipped at 500 chars` flag when match text was cut, and
  `N binary file(s) skipped` / `N oversized file(s) skipped` when files were
  not searched at all (see [Grep bounds](#grep-bounds)).
- Every other tool returns its structured result as JSON.
- A refused `git_commit` carries git's own reason: stderr when git wrote
  one, else stdout (an empty index prints `nothing to commit` on stdout).
  `git_branch` (list) reads `refs/heads`, so it names only real branches —
  never the `(HEAD detached at …)` line `git branch` prints — and a branch
  that shares its name with a tag is listed by its plain name.
- A refused call is one line: `error <code>: <message>` — the codes are
  `invalid_args`, `not_found`, `is_directory`, `permission_denied`,
  `no_match`, `ambiguous_match`, `file_too_large`, `journal_failed`,
  `not_a_repo`, `symlink_escape`, `tool_failed` (and `unknown_tool` /
  `internal`).

## Symlinked writes

`write` and `edit` follow symlinks instead of replacing them (issue
[#140](https://github.com/konic-labs/kubic/issues/140)): the atomic tmp is
written beside the **resolved** file and renamed onto it, so writing to a
link updates its target and the link stays a link — the workspace never
gains a surprise regular file and the target never keeps the old content.
The journal records that resolved path (workspace-relative), so `diff` and
`status` name the file whose content changed, the end-of-run sweep keys it
exactly like the walk does — no phantom `write` of the target and no phantom
`delete` of the link — and `kubic undo` restores the target with the link
left in place. A link (or a symlinked directory above the path) whose target
resolves **outside the workspace** is refused with
`error symlink_escape: …` before anything is journaled or written; the tool
never writes through it, however the workspace root is spelled (the physical
`realpath` counts as inside). A failed write or rename removes its tmp
(`<target>.kubic-tmp-<pid>-<n>`) instead of leaking it into the workspace,
and residue a crashed run left at that name is collected before the next
write. A dangling link has no target to resolve, so the write replaces the
link itself.

## Search walk (`find` and `grep`)

`find` and `grep` share one recursive walk (issue
[#172](https://github.com/konic-labs/kubic/issues/172)), started at `root`
(default `.`):

- **Skipped:** `.git` (always, whatever a `.gitignore` says), `node_modules`,
  and every path a `.gitignore` on the way down excludes (each file's rules
  scope to its own subtree; a nested `!` can re-include a broader ignore). A
  `.gitignore` in a directory *above* the walk root is not read.
- **Symlinks are never followed** and never listed — file or directory,
  dangling or not — so a link loop cannot return the same file under many
  paths. The `root` you name is read as given, even if it is itself a link.
- **Caps:** at most **10,000** entries and **100** directory levels, plus the
  op's own `maxResults` / `maxMatches` (default 100). A result a cap cut is
  marked `truncated` and names the cap and where it hit, as shown above.

## Line endings and BOM

`edit` normalizes what it matches against, then restores what the file had
(issue [#195](https://github.com/konic-labs/kubic/issues/195)):

- **Line endings:** the file's dominant ending is detected, the file body,
  `oldText` and `newText` are normalized to LF for matching and replacement,
  and the dominant ending is restored on write. A CRLF file with an LF
  multi-line `oldText` edits where it used to be `no_match`, the result never
  mixes endings, and an LF file is byte-for-byte unchanged apart from the
  replacement. A tie between CRLF and bare LF goes to LF, and a mixed file
  comes out uniform.
- **BOM:** a leading UTF-8 BOM is stripped from the file body and from both
  model texts before matching, and re-added on write only when the file had
  one — so a first-line edit in a BOM file succeeds, the BOM survives, and a
  replacement can never introduce a second one. An `oldText` that is nothing
  but a BOM (empty after normalization) is refused with `invalid_args`.

`expectCount` counts on the normalized text, and the journal records the
real pre- and post-images (BOM and endings included), so `kubic undo`
restores the CRLF/BOM file exactly as it was.

## Grep bounds

`grep` bounds what it reads and what it returns (issue
[#180](https://github.com/konic-labs/kubic/issues/180)):

- **Matching lines are clipped at 500 characters** (`GREP_MAX_LINE_LENGTH`,
  §27.5 / Pi's own constant) and the result carries `linesTruncated: true`
  — a minified bundle's 5 MB line can no longer flood the context. The line
  *number* stays exact; only the text is partial, and the header says
  `lines clipped at 500 chars`.
- **Binary files are skipped and counted** (`skippedBinary`): a file whose
  content contains a NUL byte is never matched — the same rule `read` uses —
  and the header says `N binary file(s) skipped`. Skipping binaries is the
  tool's contract, so it does not mark the search `truncated`.
- **Files over 8 MiB are skipped and counted** (`skippedOversized`): the
  file costs one `stat` and is never opened, so memory is bounded by the
  text bound rather than by the largest file in the tree. Because an
  unsearched text candidate can hide matches, this one *does* mark the
  result `truncated`, with a notice naming the bound.
- **The whole result stays within 51200 bytes** (`GREP_RESULT_MAX_BYTES`,
  read's output cap): matches are added while they fit, the search stops at
  the last whole line, and the header names `output cap 51200B reached`.
- `include` remains a **path substring**, not a glob — stated in the tool
  schema (`OPERATION_PARAMETERS.grep.include`) and in the tool description,
  and pinned by `ops/grep.test.ts`.

## Bash limits

- **Timeout:** `timeout` is in seconds. Without one the command gets **120
  s**; a model-supplied value is clamped to **600 s**. A command still
  running at the limit is killed and the header says `timed out`. Operators
  change the two limits with `KUBIC_BASH_TIMEOUT` and
  `KUBIC_BASH_MAX_TIMEOUT` (see
  [configuration](configuration.md)); a malformed value fails the call
  naming the variable rather than falling back.
- **Background jobs:** processes the command backgrounds (`cmd &`) are killed
  when the command ends **unless the operator sets
  `KUBIC_BASH_KEEP_BACKGROUND=1`** (or `true`). When they are killed, the
  stderr stream ends with `[kubic: background processes started by this
  command were killed after it exited (KUBIC_BASH_KEEP_BACKGROUND=1 keeps
  them)]`; when kept, they are left running, detached, outlive Kubic, and the
  stream says so instead.
- **Scope of the overrides:** the three `KUBIC_BASH_*` variables are read by
  the bash tool from its own process environment, so they apply to
  `kubic run` and `kubic tui`. They are **not yet forwarded to orchestrator
  workers** (the worker environment allowlist does not carry them; issue
  [#201](https://github.com/konic-labs/kubic/issues/201)), so a worker
  always uses the 120 s / 600 s limits and kills its background jobs.
- **Output:** each stream keeps its last 64 KiB (`[kubic: N leading chars
  dropped]` header, `, output truncated` flag).

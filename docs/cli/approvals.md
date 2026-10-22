# Approvals

> When a tool call needs your decision, how you answer it in the TUI, and
> what each trigger detects. The policy keys are on
> [configuration](configuration.md).

## The approval card

A challenged call turns the editor into an **approval card** instead of being
refused: an amber frame with the
`APPROVAL` badge, the tool and `1 of N`; the exact command (`$ …`, its
destructive words bold) — or, for an `edit` or `write`, the diff it would make
against the file on disk (`+A −R` in the frame); one plain-language row for the
reason (`▲ destructive   it can delete or overwrite files`), the working
directory (and, for a file change, that the journal keeps the old file), the
next waiting ask (`next: …`), and the keys. `?` opens the model's own
explanation. The transcript above stays readable — `PgUp` scrolls it — while
the header shows `1 WAITING`, the call's card `◆ waiting for you` and the
status line `needs approval`. Each capability a call trips is asked on its
own, so a command that is both destructive and networked is `1 of 2`, then
`2 of 2`. The card names the tool class and the exact command, so the decision
is made on what was actually asked, not on the tool's name. The command is shown **whole**:
it is the same text the approval key is computed from, wrapped across rows and
never silently cut, with three display-only changes. Control, bidi, zero-width
and other default-ignorable characters (including the Hangul fillers
`\u3164`/`\u115f` and tag characters) are shown as visible escapes such as
`\x1b` or `\u202e`; a literal `[REDACTED]` in the command is shown as
`\x5bREDACTED]`, so the marker only ever means "a value was hidden here"; and
secret **values** are replaced with `[REDACTED]`. That redaction is narrow on
purpose — the dialog exists so you see what runs, and a hidden word can be the
destructive verb:

- It replaces known key shapes (`sk-…`, `AKIA…`, `ghp_…`, `xox…-` with a
  realistic length and a word boundary, so `task-…` or `ghost_database` are
  not keys), the value in `NAME=value` (no whitespace around the `=`), in
  `name: value` (spaces or tabs after the colon), the operand of a
  secret-named flag on the same line (`--token abc`), an `Authorization:`
  header value with its scheme, and a bare `bearer …` followed by a
  credential-looking run (20+ characters mixing letters and digits).
- It never replaces the next command word: `find / -name secret -delete`,
  `echo bearer rm -rf ~/work`, `SECRET_KEY= shred -u x` (an empty value),
  `secret:/etc` (a mount) and `release-token:main` (a refspec) are shown exactly
  as written, and a value never spans a newline.
- It never redacts anything the shell would expand: a value containing
  `$(…)`, a backtick, `${…}` or `$NAME` is shown verbatim, so
  `API_KEY="$(curl … | sh)" npm test` reads as what it runs.

One-line summaries (audit detail, trajectory) are different text: they keep the broader block-reason redaction —
the same secret-shape table the audit backstop uses (`sk-…`, `AKIA…`,
`ghp_…`, `xox…-`, PEM headers), the full credential after an `Authorization:`
header or a bare `bearer`/`basic` scheme, a `-u`/`--user`/`--proxy-user`
`user:password` operand, and URL userinfo (`https://user:pw@host`) — and, when
they shorten a command, say so: `… (+N chars)`. The narrow redaction is what
the approval card's command shows — it carries the full command to the seat
that decides, with the operator still seeing the host and the flag. The summary's broad
redaction is the safe over-redacting one.

Rows wrap by terminal **display columns**, not by character count: wide (CJK)
characters count two columns, and a combining sequence or an emoji cluster is
never split, so every character of the command appears in the rows and none is
cut by the card's edge. A command taller than a page (8 rows) shows one page at
a time with an explicit `… lines 1–8 of N` marker, and `v` pages through it;
on an edit, `v` opens the whole diff (twelve rows show by default). When the
card does not fit — it needs its own rows plus six more for the header, the
status line, the key hints and three rows of transcript — it **fails closed**:
it says `the terminal is too short to show this command — enlarge it` and
every allow key (`a`, `Ctrl-S`) is inert until the terminal is tall enough, so
you can never allow what you cannot see. `d` (after arming) and `Esc` (at
once) still deny, and the card re-checks on every frame and key, so enlarging
the terminal restores it. The card is the same at every width; below 60
columns its reason rows keep only their labels and the keys wrap. Denying
leaves the session running; the transcript shows the refusal instead of the
call's result. Quitting with an ask still pending denies it, so a shutdown
cannot strand the turn.

An approval is consent to run code with your authority, so keys typed for
the editor can never produce one. Asks arrive while you may be typing the
next prompt, so the card is a capturing modal: while it shows, printable
keys are dropped instead of reaching your draft (the global keys `Ctrl-C`,
`Ctrl-D`, `Ctrl-T`, `Ctrl-O`, `Ctrl-R` and `Ctrl-X` still work). Three rules keep type-ahead and a held key from answering:

- **Arming delay, 400 ms.** Each request — including the next queued one —
  starts with decision keys ignored and the hint row reading
  `… keys unlock in a moment · [Esc] deny now`. `Esc` (deny) is the only key
  that acts immediately.
- **Quiet period, 1.5 s.** Every other key while the overlay shows — a
  dropped letter, a decision key pressed too early, a `v` page turn, a global
  key, or a key-repeat event — restarts the unlock, and this time it needs 1.5 s
  of quiet since the *last* such key (a thinking pause in prose is about half a
  second, so 400 ms would not be enough). The hint row re-locks while it runs.
  A lone decision key pressed after the overlay has been quiet for the
  period still decides at once.
- **Held keys.** Terminals that report key events flag repeats and they are
  ignored. Terminals that do not (Terminal.app, VTE, tmux) send a held `a` as
  plain repeated bytes; a decision key that arrives within 700 ms of the
  *same* key is therefore treated as a repeat — swallowed, and it restarts the
  quiet period. `Esc` is exempt.

Once armed the hint row shows the live keys:
`a` allows once, `Ctrl-S` allows for the session — a key ordinary typing
cannot produce — and `d` or `Esc` denies. The keys live in the approval key
registry, which refuses a map where two actions share a key, allow-session
is a prose key, or an approval key shadows one of the global keys.

### The card's keys

- **`a`, allow once**: this call only, after the arming delay and the quiet
  period, and only while the card can show the whole command. Nothing is
  stored: the next identical call asks again.
- **`Ctrl+S`, allow for the session**: after the arming delay and the quiet
  period, and only while the card can show the whole command; never a bare
  letter. It is latched in `<session>/approvals.json`, so identical calls in
  this session are not asked again, after a re-attach too.
- **`A`, allow all edits this turn**: for an edit or write ask that a role's
  `requires` raised inside the workspace, this call and every such ask until
  the turn ends. Never another capability: a write outside the workspace,
  into `.kubic/` or onto credentials still asks. The status line says `edits
  auto-approved this turn` while it applies, and nothing is latched.
- **`d` or `Esc`, deny**: `Esc` acts at once, the only immediate key, and `d`
  after the arming delay. A denial latches for the session like `Ctrl+S`, so
  the same operation is refused without asking again.
- **`c`, deny with a comment**: opens a one-line input on the card. `Enter`
  denies with `denied by the user: <comment>` as the reason the model reads
  (an empty comment is a plain deny), and `Esc` goes back to the card. At most
  500 characters, recorded in the ledger as the denial's reason; like `d`, the
  denial latches for the session.
- **`e`, edit the command, then allow it** (shell asks only): opens the
  proposed command in a one-line input, and `Enter` runs what you typed
  instead. The edited command is judged again from the start, so an edit that
  is itself destructive asks again; an unchanged command is a plain allow
  once, and an emptied one is not accepted. The call's result opens with
  `[edited by the user — ran: <yours> (proposed: <the model's>)]`, so neither
  the model nor the transcript takes it for the proposed command's output.
  Nothing is latched; the ledger records both commands.
- **`v`**: shows the next page of a command too tall for the card, or an
  edit's whole diff. It never decides.
- **`?`**: opens and closes the model's explanation for the ask. It never
  decides.

## What asks

Each challenged call names the capability it raises, and `autoApprove`
entries name the same capabilities: the strings `detectTriggers`
(`packages/host/src/approvals/triggers.ts`) raises on tool calls. The known set
(`CAPABILITIES`):

| Capability | Raised by |
| --- | --- |
| [`network`](#network) | A command that reaches the network while `network = "none"`. |
| [`credentials`](#credentials) | Reaching a known credential location: `~/.ssh`, `~/.aws`, `.env` files, the system keychain. |
| [`git-push`](#git-push) | `git push`, and changes to the remotes. |
| [`destructive-shell`](#destructive-shell) | Deleting or rewriting what the journal cannot restore: `rm -rf`, force pushes, history rewrites, infrastructure teardown. |
| [`install`](#install) | Package installs and fetch-and-run launchers (`npm install`, `npx`, `pip install`, …). |
| [`deploy`](#deploy) | Changes to running infrastructure (`kubectl apply`, `terraform apply`, platform deploys). |
| [`outside-write`](#outside-write) | A `bash` write outside the workspace. |
| [`privilege-escalation`](#privilege-escalation) | `sudo` anywhere in the command. |
| [`kubic-state-write`](#kubic-state-write) | A write into Kubic's own state or the workspace's `.git/`. Always asks. |

`requires:<tool>` is accepted alongside them (the per-tool trigger). A name
outside this set is reported by `kubic doctor` (`policy:approvals`), never
silently ignored.

### `network`

A network command under `network = "none"`, including one hidden inside `$(…)` (nested substitutions included), backticks, or after `eval`. The transfer clients raise wherever their name appears: `curl`, `wget`, `ssh`, `scp`, `sftp`, `ftp`, `lftp`, `telnet`, `nc`, `ncat`, `netcat`, `socat`, `aria2c`. These raise by subcommand, read for the command a segment runs (past its wrappers and the tool's own options): `git clone`/`fetch`/`pull`/`ls-remote`, `git remote update`, `git submodule update`/`sync`, `git lfs fetch`/`pull`/`push`/`clone`; `gh` (anything but `help`, `version`, `completion`, `alias`, `config`); `docker`/`podman` `pull`/`push`/`login`/`search`/`build`/`buildx`; `cargo fetch`/`update`/`search`/`publish`/`login`; `go get`, `go mod download`; `npm`/`pnpm`/`yarn` `view`/`info`/`show`/`search`/`audit`/`publish`/`login`/`adduser`/`ping`/`outdated`/`whoami`; `pip`/`pip3` `download`/`index`/`search`; `openssl s_client`/`s_time`; and `rsync` with a remote operand (`host:path`, `rsync://`). Remote for everything they do except their own help or version: database clients (`psql`, `mysql`, `mariadb`, `mongosh`, `redis-cli`, `cqlsh`, `sqlcmd`, `clickhouse-client`, `bq`, …), deploy CLIs (`fly`/`flyctl`, `vercel`, `netlify`, `heroku`, `wrangler`, `firebase`, `supabase`, `railway`, `doctl`, `eksctl`, `serverless`, `cdk`, `sam`, …), `gsutil`, network diagnostics (`dig`, `nslookup`, `ping`, `traceroute`, `nmap`, `whois`) and HTTP clients (`http`/`https`, `xh`, `grpcurl`, `websocat`, `huggingface-cli`/`hf`). Remote except for their local configuration and rendering subcommands: `aws` (not `configure`), `gcloud` (not `config`, `info`), `az` (not `config`), `kubectl` (not `config`, `completion`, `kustomize`, `plugin`, `version --client`), `helm` (not `template`, `lint`, `create`, `package`, `verify`), `terraform`/`tofu` (not `fmt`, `validate`, `version`, `console`, `graph`) and `pulumi`. By subcommand also: `docker run`/`create` and `docker compose up`/`pull`/`push`/`build`/`run`/`create` (they pull images), `git submodule add`, `rclone` with a `remote:` operand, `deno` with a URL, publishing (`npm unpublish`/`deprecate`/`owner`/`dist-tag`/`token`/`access`, `cargo yank`/`owner`, `gem push`/`yank`/`owner`, `twine upload`, `poetry`/`uv`/`hatch`/`flit publish`, `dotnet nuget push`, `mvn deploy`, `gradle publish…`) and `ollama pull`/`push`/`run`. `git push` is `git-push`'s to raise. Stated misses: an interpreter (`python3 -c`, `node -e`), a build or install script (`go build`, `cargo build` fetching dependencies), and a tool this list does not name.

### `credentials`

An access to a listed credential location, under the effective `credentials` class — which enforces as `none`, `allowlist` included. Bash: home credential paths (`~/.aws/`, `~/.ssh/` — every child except the known-public `known_hosts*`, `authorized_keys*` and `*.pub`, so `~/.ssh/github` and `~/.ssh/*` raise, `~/.config/gh/`, `~/.config/gcloud/`, `~/.docker/config.json`, `~/.kube/config`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.azure/`) spelled `~`, `$HOME`, `${HOME}`, `/Users/<user>` or `/home/<user>`, reads of the OS credential store (`security find-generic-password`, `find-internet-password`, `dump-keychain` and `export` on macOS, `secret-tool lookup` and `search` on Linux), plus workspace credential files (`.env`, `.env.*` except `.env.example`/`.env.sample`/`.env.template`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` — the public `*.pub` halves excluded). Read-family tools (`read`, `ls`, `find`, `grep`): the same names in the `path`/`root` argument, as typed before the confine rewrite (a home path is rewritten before the tool opens it, but the ask sees it), and the name filters `grep.include` / `find.nameContains` when the filter is a substring of a credential name or contains one (`include: "env"` reaches `.env`, `include: "src/.env.local"` too) — filters shorter than 3 characters are not treated as credential selectors. Matching is case-folded, like the default macOS/Windows volumes. Lexical detection, not enforcement: an obfuscated or built-up path is a stated miss. Also fires via `requires:<tool>`.

### `git-push`

`git push`, `git remote add/set-url/remove/rename` — in any command segment (`ls; git push`, `cd x && git push`), after git global options (`git -C . push`, `git -c k=v push`, `--git-dir=…`, `--work-tree=…`, `--no-pager`; an option argument may be quoted: `git -C "my dir" push`) and after any command-position boundary: whitespace, `| ; &`, `(` (`$(git push)`), a path (`/usr/bin/git push`), a backslash (`\git push`), a quote (`bash -c 'git push'`, `sh -c "git push"`) or a backtick. The word must be exactly `git` followed by whitespace — `mygit push`, `digit push`, `gitpush` and `git-lfs push` do not raise.

### `destructive-shell`

The destructive matcher (`rm -rf`, `mkfs`, `dd of=/dev/…`, `shred`, `git clean -f`, `chmod/chown -R`, force pushes — `git push --force`/`-f`/`--force-with-lease`/`--force-if-includes`/`+refspec` — `find … -delete`, `git reset --hard`, an amended commit — `git commit --amend`, and the `git_commit` tool with `amend` — `git checkout -- <path>`/`.`/`-f`, and `git restore` of the working tree; a staged-only `git restore --staged` is not destructive, and a merge — `git merge` or the `git_merge` tool — is a workspace write the journal records). History and refs the journal never sees, because its sweep skips `.git/`: a forced branch delete or move (`git branch -D`, `--delete --force`, `-f`), a dropped or cleared stash, `git reflog expire`/`delete`, `git gc --prune`, `git prune`, `git update-ref -d`, `git tag -d`, `git filter-branch`/`filter-repo`, a rebase (not `--abort`, `--continue`, `--skip` or `--quit`), a reset to another commit (`--soft`, `--mixed`, `--keep`, `--merge`, `HEAD~n`, a commit id), `git checkout -B`, `git switch -C`/`--discard-changes`/`-f` and `git worktree remove`. Teardown the journal cannot restore: `terraform`/`tofu destroy` (and `apply -destroy`, `state rm`, `workspace delete`), `pulumi destroy`, `helm uninstall`, `aws … delete-*`/`terminate-*`/`s3 rm`/`s3 rb`, `gsutil rm`/`rb`, `gcloud … delete`, `az … delete`, `gh … delete`, a container prune or `volume rm`, `npm unpublish`, `dropdb`, `crontab -r`, and SQL that drops, truncates or deletes data (`DROP TABLE`, `TRUNCATE`, `DELETE FROM`, `FLUSHALL`, …) in a command that runs a database client, here-documents included. The quiet forms stay quiet: `git branch -d`, `git stash list`/`pop`, bare `git reset`, `git reset -- <path>`, `git rebase --abort`. including a destructive verb unwrapped through `$(…)` (nested substitutions included), backticks, or after `eval`. `rm`/`rmdir` counts wherever it is the command that runs: at a command start or after `then`, `do`, `else`, `{`, `!` or a subshell `(`; behind `sudo`, `doas`, `env`, `nice`, `ionice`, `timeout`, `time`, `nohup`, `command`, `builtin`, `exec`, `stdbuf` or a `NAME=value` assignment; spelled `\rm`, `'rm'` or `/bin/rm`. It raises when it is recursive or forced, or names a target outside the workspace or on a sensitive path; run by `xargs` or by `find -exec`/`-execdir`/`-ok`/`-okdir` it is a bulk delete and raises whatever its flags. Stated misses: a delete inside a string another interpreter runs (`bash -c 'rm …'`, `python3 -c`, `node -e`).

### `install`

Package installs and fetch-and-run launchers, in any segment: `npm install/i/add/ci/exec/x`, `npx`, `pnpm install/i/add/dlx`, `yarn` (bare), `yarn add/install/dlx/global add`, `bun install/i/add`, `bunx`, `pip install`, `pipx install/run`, `uv add`, `uv sync`, `uv pip install`, `uv tool install`, `uvx`, `poetry add/install`, `pdm add/install`, `pipenv install`, `conda`/`mamba`/`micromamba install/create`, `gem install`, `bundle install/add`, `composer require/install`, `brew install`, `port install`, `apt install`, `yum`/`dnf`/`zypper install`, `apk add`, `pacman -S…`, `snap install`, `deno install/add`, `cargo install/add`, `go install`. Scripts such as `npm test`, `npm run build`, `yarn build` and `uv run` are not installs.

### `deploy`

Changes to running infrastructure: `kubectl apply/create/delete/rollout/patch/replace/scale/edit/set/label/annotate/drain/cordon/uncordon/taint/expose/autoscale`, `helm install/upgrade/rollback/uninstall`, `terraform`/`tofu apply/destroy/import`, `pulumi up/destroy/refresh`, `docker push`, `gh release create`, and platform deploys (`fly deploy`, `vercel deploy`/`--prod`, `netlify deploy`, `wrangler deploy`, `firebase deploy`, `serverless`/`sls`/`cdk`/`sam deploy`, `railway up`, `supabase db push`/`functions deploy`, `gcloud app/run/functions deploy`, `az webapp/functionapp deploy/up`).

### `outside-write`

A write outside the workspace in bash: any redirect target (`>`, `>>`, `2>`, `&>`, `&>>`, `>|`, `>& file` — every one in the command, not only the first), and the paths the shell writers name (listed below, under the heuristics). A delete outside the workspace (`rm`, `rmdir`, `find -delete`) raises `destructive-shell` instead. The `write` and `edit` tools never write outside the workspace: such a path is refused by name before any ask — full access and `autoApprove` included — so no card offers an allow the call could not honour, and a change outside the workspace goes through bash. A `write`/`edit` path under `~/.kubic` still raises `outside-write` when the workspace is the home directory.

### `privilege-escalation`

`sudo` anywhere in the command.

### `kubic-state-write`

A write into Kubic's control plane — `<workspace>/.kubic/` (`config.toml`, `roles/`, …) and, for a target outside the workspace, any ancestor's `.kubic/` (the project's, from a subdirectory) or `~/.kubic/` (the global `config.toml`) — or into the workspace's own `.git/` (hooks, `config`): a planted hook runs on the host's later git commands, so it asks too: the `write`/`edit` tools, any redirect target (`>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `N>`), the paths the shell writers name (the same table as `outside-write`), or an `rm`/`rmdir`/`mv` operand and what `find -delete` walks (deleting or moving control-plane state is tampering; a `cp` source is only read). Relative targets resolve against a preceding `cd`/`pushd`, quote-split and backslash-escaped segments are read as the shell reads them (`".kubic"/roles/r.md`), and `$HOME/`/`${HOME}/` count exactly like `~/`. **Always asks**: `autoApprove` and `--full-access` never answer it (an `autoApprove` entry naming it is ignored and warned about by `kubic doctor`). Writes into `.kubic/journal/`, `.kubic/audit/` and `.kubic/sessions/` at any of those roots, and into the session root in use, are refused outright as a tool error (see [journal and safety](../architecture/journal-and-safety.md)).

## How detection works

Detection is a literal-pattern heuristic over the command string and the
read-family tool paths, not sandbox-grade shell parsing, and it says so. The
documented heuristics:

- **Command segments** — a command ends at `|`, `;`, `&` or a line break
  (a CRLF line ending included), so each line of a multi-line script is its
  own command: `echo hi` with `rm -rf /` on the next line raises
  destructive-shell, and `cp a /etc/b` with `echo done` on the next line
  raises outside-write.
- **Shell writers** — what these commands write is read from their
  arguments, for the command a segment runs: past reserved words,
  `NAME=value` assignments and the wrappers listed under `destructive-shell`
  (`xargs` included).

  | Command | What it writes |
  | --- | --- |
  | `cp`, `install` | The destination: `-t DIR`, else the last argument; every argument of `install -d`. |
  | `mv` | Every argument: the sources leave their place. |
  | `ln` | Every argument: a link to an outside path is a way out of the workspace. |
  | `tee`, `touch`, `mkdir`, `truncate` | Every file argument. |
  | `chmod`, `chown`, `chgrp` | The files after the mode or owner. |
  | `dd` | `of=`. |
  | `sed`, `perl` | The files of an in-place edit (`-i`, `--in-place`). |
  | `sort` | `-o`, `--output`. |
  | `rsync` | The destination, `--backup-dir`, `--log-file`, `--temp-dir`, `--partial-dir`. |
  | `tar` | The archive (`-f`) when it creates or adds to one; `-C` when it extracts. |
  | `unzip` | `-d`. |
  | `git` | The directory of `clone`, the path of `init` and `worktree add`, `--separate-git-dir`, and a global `-C`. |
  | `curl` | `-o`, `--output-dir`, `-D`, `-c`, `--trace`, `--stderr`, `--etag-save`. |
  | `wget` | `-O`, `-P`, `-o`, `-a`, `--save-cookies`. |
  | `find` | The `-fprint`/`-fls` files, and what it walks when its `-exec`/`-execdir`/`-ok`/`-okdir` runs a writer. |

  A comment and every redirection are dropped before the arguments are read
  (`cp a /etc/x 2>/dev/null` and `cp a /etc/x # note` name `/etc/x`), words
  are read quote-aware (`"/etc/my dir/x"` is one path), and segments split
  the way the shell splits them. Besides the table, any `tee`, `cp`, `mv` or
  `install` word anywhere in a command — inside `bash -c '…'` too — has its
  last argument checked, which over-triggers on text that only mentions the
  command. A target lifted out of `$(…)` has that span's closing `)` trimmed
  (`$(cp a /etc/b)` → `/etc/b`) — scoped to lifted tokens: a plain target
  is never trimmed, so `tee '/work)'` names the literal sibling path
  `/work)` and still raises outside-write. The outside check itself stays
  path-boundary aware (`/work-evil` is not `/work`). Stated misses: paths
  that come from input (`xargs`, a file list, a variable), a writer run by an
  interpreter (`bash -c 'touch …'`, `python3 -c`), and a write through a
  symlink.
- **Every redirect** — each redirect operator in the command is checked,
  within one segment and across `;`, `&&`, `||`, `|` and newlines, so
  `echo a > notes.txt && echo b > /etc/cron.d/x` raises outside-write.
  Covered forms: `>`, `>>`, fd-prefixed (`2>`, `1>>`), `&>`, `&>>`,
  clobber `>|`, and `>&` — an fd duplication (`2>&1`, `>&-`) is not a
  file and is skipped, while `>& out.txt` names a file. The target is the
  next token up to whitespace or a `|;&<>` character, read the way the
  shell reads it: quotes and backslash escapes come off wherever they sit
  (`echo x > ".."/x` and `> \../x` name `../x` and raise outside-write).
  Stream pseudo-devices persist nothing and never raise: exactly
  `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty` and `/dev/fd/<n>`
  (so `cmd > out.txt 2>/dev/null` stays quiet); any other `/dev` target
  still raises.
- **Shell-expanded and `cd`-relative targets** — bash expands a target
  before it writes, the detector does not, so a target starting with `~`
  (`~/.bashrc`, `~root/x`) or `$` (`$HOME/.zshrc`, `${HOME}/x`,
  `$OUT/file`) counts as outside-write, fail-closed. A `cd <dir>` or
  `pushd <dir>` at a command START — at the start of the command or after
  `;`, `&`, `|`, a newline or `(`, then any run of `{`, `then`, `do`, `else`,
  `elif`, `if`, `while`, `until`, a `!` negation and the `command`/`builtin`
  wrappers (`{ cd /tmp; echo x > y; }`, `if cd /tmp; then …`); a keyword inside an
  argument (`git commit -m 'then cd /x'`) starts nothing — moves the
  directory later relative targets resolve against: `cd /etc && echo x > y`
  raises, `cd sub && echo x > y` does not. After a `cd` to an unknown place
  (bare `cd`, `cd ~`, `cd $X`, `cd -`, any `popd`) every later relative target
  raises. The `cd` trail is lexical, so it is only ONE of two candidates: a
  target is outside if it is outside as TYPED (against the workspace) or as
  resolved against the tracked directory. A subshell `(cd /etc); echo x > y`, a
  conditional `false && cd sub; echo x > ../y` or a `cd` quoted into an
  argument therefore over-trigger — they can never hide a write (a real `cd
  sub && echo x > ../y` over-triggers too). A redirect on the `cd` itself
  applies before it runs. A tracked directory longer than 1 KiB is treated as
  unknown. A
  `$VAR` in the middle of a target (`out/$f.log`) is not expanded and is
  checked as written. Any target under `~/.kubic` (session state,
  `posture.json`, `approvals.json`) — including a `write`/`edit` path —
  raises outside-write even when the workspace is the home directory.
  Tool paths are not shell-expanded: the `write` tool takes `~/.bashrc`
  literally, as a workspace file.
- **Control-plane targets** (`kubic-state-write`) — the same
  target scan feeds the control-plane guard, with these additions. Every
  target is classified TWICE and either candidate being control-plane counts:
  as typed against the workspace, and resolved against the tracked
  `cd`/`pushd` directory (`cd .kubic/roles && echo x > r.md` writes
  `.kubic/roles/r.md`; `cd ~`, `cd $HOME/x` resolve against the home directory
  here, unlike the outside-write rule above). The trail is lexical, so it only
  ever adds a candidate: `(cd x); echo p > .kubic/journal/y` is still refused.
  A redirect on the `cd` command itself (`cd .. > config.toml`) resolves against
  the directory BEFORE that `cd`, and redirection words are never the
  directory (`cd 2>/dev/null .kubic`), nor are `--` and `-L`/`-P`. `$PWD`, `${PWD}`
  and `~+` are the current directory (`cd "$PWD/.kubic"`); `~-`, `$OLDPWD` and
  a `cd` to an unknown place read a relative `.kubic` segment as the
  workspace's own, fail-closed. Inner quotes and backslash escapes are removed
  before matching (`".kubic"/roles/r.md`, `.k"ub"ic/…`, `\.kubic/…`), and `$HOME`,
  `${HOME}` and `${HOME:-…}` expand like `~` (`$HOMEDIR` and `~user` do not).
  Operands of `rm` and `mv` count as writes: `rm .kubic/journal/index.jsonl`
  is refused outright, `rm .kubic/roles/r.md` asks. A glob or brace list that
  COULD expand into `.kubic/journal`, `audit`, `sessions`, `config.toml` or
  `roles` — or into the state directory itself — is refused, not just asked
  (`rm .kubic/journa?/*`, `rm -rf .kubic/*`, `rm .kub*`, `rm .kubic/{journal,x}/y`);
  it is deliberately conservative (a leading `*` may match a dotfile, and a
  brace list past 32 expansions that names `.kubic` is refused). Still
  misses, by design: a path built from a variable set elsewhere (`D=.kubic; echo
  x > $D/roles/r.md`), a script file, an interpreter (`bash -c 'cd
  .kubic && …'`), `time cd`, `eval cd`, a subshell `cd` that undoes an earlier
  one (`cd .kubic; (cd ..); echo x > config.toml`), a symlink, and a `cd` chain
  that started from an unknown place before reaching `.kubic` (`cd $X && cd
  .kubic && echo x > config.toml`).
- **Git verb scan** — the `git` word is found after the boundaries listed
  in the table, then the option run is walked token by token in linear time
  (a long `--namespace --namespace …` chain cannot stall the scan; it runs
  before every bash call). Words are read twice and either reading reaching
  `push` raises: quote-aware (a quoted option argument is one word, a
  backslash escapes the next character outside single quotes, a quote with no
  closer is an ordinary character) and plain whitespace-split (the original
  reading, the safety net for shell syntax the tokenizer misreads such as
  `git -c user.name=O\'Brien push`). A `!` is a boundary too
  (`-c alias.p='!git push'`). It only ever widens what raises, so the
  over-trigger stays an ask: `git -c "a push" status` still reads as a push.
- **`sudo` over-trigger** — `privilege-escalation` fires on the word `sudo`
  anywhere in the raw command, quoted text included
  (`echo "needs sudo"` raises it). A raised capability becomes an ask,
  never a silent grant, so the false positive costs a confirmation.
- **Indirection unwrap** — a destructive/network verb behind `$(…)`,
  backticks, or `eval` raises the underlying capability, and unwrapping
  runs to a fixpoint: single-level (`$(rm -rf /)`), eval-of-substitution
  (`eval $(rm -rf /)`), and nested (`echo $(echo $(rm -rf /))`) forms all
  raise. `$(…)` is collected with a bounded literal `$(…)`/`)` pairing scan
  (depth cap 16; the cap's unmatched-opener markers still consume closers,
  so the effective nesting threshold is 2× the cap — 31 nesting levels
  raise, 32 stay unraised, pinned in the detector tests) — a stated bound,
  never a fabricated unwrap.
- **Credential paths** — the `credentials` trigger is lexical,
  like every detector here: it recognizes the listed home locations in a
  bash command (`~/.aws/credentials`, `$HOME/.ssh/id_rsa`, `/Users/x/.netrc`;
  the `~`, `$HOME`, `${HOME}` and absolute home spellings), a read of the OS
  credential store (`security find-generic-password`, `secret-tool lookup`),
  the listed file names in a read-family tool path, and the
  `grep.include`/`find.nameContains`
  name filters that select those files by substring (`include: "env"`
  reaches `.env`; a filter shorter than 3 characters is not treated as a
  credential selector). Matching is case-folded, like the filesystems it
  guards (`.ENV`, `~/.AWS/credentials`). Over-triggering is deliberate
  (`*.pem` is flagged whether or not it holds a key) and a raised credential
  capability is an ask, never a silent grant; the known-public files
  (`*.pub`, `authorized_keys*`, `known_hosts*`) stay quiet. Stated misses: a
  path the list does not name, another program reading the credential store
  (a script calling the keychain API; on macOS, `[sandbox]` closes the
  keychain to it), an obfuscated or split spelling
  (`~/.a''ws/credentials`, `p=~/.ssh; cat $p/id_rsa`), a Windows-style
  backslash spelling, and a credential reached indirectly in bash (`bash -c`,
  a script, a symlink). A read-family tool path that a symlink leads to a
  credential file inside the workspace raises `credentials` like the file
  itself; one a link leads outside the workspace is refused by the tool
  (`symlink_escape`). The `~/.ssh/*`
  directory name also matches the network verb scan, so those commands raise
  `network` as well.

### What it does not catch

These are documented gaps, not silently handled:
interpreter-based verbs (`bash -c "rm -rf …"`, `python3 -c`, `node -e` —
the command is data to the literal patterns; a `git push` inside `bash -c '…'`
is the one exception, caught because a quote is a boundary for the `git` word), network use through
an interpreter (`python -c`, `node -e`), a script or a tool the `network` row
does not list, substitution nesting past ~2× the depth cap,
quoted or backslash-obfuscated verbs the literal patterns cannot see,
whitespace tricks around redirection targets, git subcommands reached
through an alias (`git config alias.p push; git p`), `git` reached through
a variable or a name built at run time (`g=git; $g push`, `$g config …`:
the `git-push` and `.git/config` checks read the literal word `git`, though
`$(git push)` and `eval "git config …"` raise), package managers
not listed above, and installs run by a build script (`npm run setup`).
The literal verb scan over-triggers on quoted text: `echo "git push
later"` raises `git-push` (an ask, never a silent grant).

## MCP server tools

An MCP server's tools go through the same pipeline: a tool its allowlist
entry lists under `approve` always asks (`requires:mcp__<server>__<tool>`,
answerable by `autoApprove`, the broker or a pre-approval file like any
other), and the others run as untriggered calls. See
[MCP servers](enterprise.md#mcp-servers).

## See also

- [TUI keys](tui-keys.md): the card's keys among the others.
- [Configuration](configuration.md): `[approvals]` and `[permissions]`.
- [For teams](enterprise.md#headless-approvals): the approval broker and
  pre-approval files for runs nobody watches.

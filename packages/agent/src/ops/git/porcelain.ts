// Parsers for git's machine-readable output: porcelain v2 status,
// submodule status and the worktree list.
interface GitRename {
  /** The file's current (new) path. */
  path: string;
  /** The path it came from; omitted when git records no original. */
  oldPath?: string;
  /** True when the rename/copy is recorded in the index (staged). */
  staged: boolean;
}

export interface GitStatus {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  // Paths with unresolved merge conflicts (UU, AA, DD, and
  // the U-in-either-slot pairs). A conflicted path is conflict work, not
  // staged or unstaged work — it appears here only.
  conflicts: string[];
  // The repo root, and one record per submodule.
  repoRoot: string;
  submodules: GitSubmodule[];
  /** Rename/copy records: the new path plus the optional old path. */
  renames: GitRename[];
  clean: boolean;
}

// Input is always `git status --porcelain=v2 -z -b`: NUL-delimited records
// mean git never quotes paths, so non-ASCII, whitespace and quote
// characters round-trip verbatim; type-2 records spell renames and copies
// out as new path + original path instead of v1's `old -> new` string; and
// the branch headers separate a detached HEAD (`# branch.head (detached)`)
// from a branch name — never guessed from one — while an unborn branch is
// just a name next to `# branch.oid (initial)`.
/**
 * Shared with the TUI workspace reader: it parses the same
 * `git status --porcelain=v2 -z -b` output `git_status` classifies, so no
 * caller grows a second status parser.
 */
export function parsePorcelainStatus(out: string): GitStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const renames: GitRename[] = [];
  let branch: string | null = '(unknown)';
  let ahead = 0;
  let behind = 0;

  const conflicts: string[] = [];
  const pushChange = (xy: string, path: string, oldPath?: string): void => {
    if (path === '') return;
    const x = xy[0] ?? '';
    const y = xy[1] ?? '';
    // Unmerged XY codes: a `U` in either slot, or the
    // both-added / both-deleted pairs. Conflict work only — never staged
    // or unstaged. The rename relation still records when git reports one.
    if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') {
      conflicts.push(path);
    } else {
      if (x !== '' && x !== '.') staged.push(path);
      if (y !== '' && y !== '.') unstaged.push(path);
    }
    if (oldPath !== undefined && oldPath !== '') {
      renames.push({ path, oldPath, staged: x === 'R' || x === 'C' });
    }
  };

  const records = out.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record === '') continue;
    if (record.startsWith('# ')) {
      const header = record.slice(2);
      if (header.startsWith('branch.head ')) {
        const head = header.slice('branch.head '.length).trim();
        branch =
          head === '(detached)' ? null : head === '' ? '(unknown)' : head;
      } else if (header.startsWith('branch.ab ')) {
        const counts = /^branch\.ab \+(\d+) -(\d+)$/.exec(header);
        if (counts !== null) {
          ahead = Number(counts[1]);
          behind = Number(counts[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === '1' || kind === 'u') {
      // Path is the last field and may contain spaces: only the fixed
      // fields before it are single-space separated.
      const fields = record.split(' ');
      pushChange(
        fields[1] ?? '',
        fields.slice(kind === '1' ? 8 : 10).join(' '),
      );
      continue;
    }
    if (kind === '2') {
      // A type-2 record's original path is the next NUL-delimited field,
      // not a record of its own.
      const fields = record.split(' ');
      const path = fields.slice(9).join(' ');
      const oldPath = records[index + 1] ?? '';
      index += 1;
      pushChange(fields[1] ?? '', path, oldPath);
      continue;
    }
    if (kind === '?') {
      const path = record.slice(2);
      if (path !== '') untracked.push(path);
    }
    // `!` (ignored) is not requested by `--porcelain=v2`; nothing else can
    // appear in this format.
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicts,
    // The parser sees no repo root and no submodules: the
    // status op fills them from its own queries; other consumers keep the
    // empty defaults.
    repoRoot: '',
    submodules: [],
    renames,
    // A conflicted tree is not clean: there is resolver work outstanding.
    clean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      conflicts.length === 0,
  };
}

export interface GitSubmodule {
  path: string;
  state: 'clean' | 'modified' | 'uninitialized' | 'conflict';
}

// One `git submodule status` line: a flag char, the sha, the path, and an
// optional ` (<describe>)` suffix, which git prints only for a clean or
// moved submodule. `+` checked out at a different commit, `-`
// uninitialized, `U` conflicted, anything else clean. Git never quotes the
// path, so it is everything between the sha and the suffix, spaces included.
export function parseSubmoduleStatus(out: string): GitSubmodule[] {
  const rows: GitSubmodule[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const flag = line[0] ?? ' ';
    let path = line.slice(1).replace(/^[0-9a-f]+ /, '');
    if (flag === ' ' || flag === '+') path = path.replace(/ \([^()]*\)$/, '');
    if (path === '') continue;
    rows.push({
      path,
      state:
        flag === '+'
          ? 'modified'
          : flag === '-'
            ? 'uninitialized'
            : flag === 'U'
              ? 'conflict'
              : 'clean',
    });
  }
  return rows;
}

export interface GitWorktreeRow {
  path: string;
  head: string;
  /** Branch short name, or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

// One `git worktree list --porcelain` block per worktree: `worktree <path>`,
// `HEAD <sha>`, then `branch <ref>` or `detached` or `bare`. Blocks are
// blank-line separated; paths are never quoted in this format, so a path is
// the rest of its line, spaces included (only a newline inside a path, which
// needs `-z`, cannot be read).
export function parseWorktreeList(out: string): GitWorktreeRow[] {
  const rows: GitWorktreeRow[] = [];
  for (const block of out.split('\n\n')) {
    let path = '';
    let head = '';
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') detached = true;
      else if (line === 'bare') bare = true;
    }
    if (path === '') continue;
    if (detached || bare) branch = null;
    rows.push({ path, head, branch, bare, detached });
  }
  return rows;
}

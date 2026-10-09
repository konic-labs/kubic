// The read-only shell class: which commands and git subcommands only read.
// --- read-only shell allowlist -------------------
//
// `shell: 'read-only-allowlist'` is an explicit, closed allowlist, not "full
// shell minus network": a read-only role must not write files or git state
// through bash. Every pipeline/`&&`/`;`
// segment must head with a read-only verb, redirection is refused, and the
// verbs that can write as a side effect (git, find, sed/perl) are checked
// for their write forms. Anything else is blocked with a named reason —
// never silently allowed. The parser is lexical (quotes are stripped, not
// interpreted), so it errs toward blocking, like every guard here.

// The verbs a read-only role may run. Deliberately a closed set: adding a
// verb is a product decision, not a fallthrough.
const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'git',
]);

// The git subcommands that only read — the same set derives the git read
// tools from.
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
]);

// git global options that take a separate argument, so the option's value is
// not mistaken for the subcommand. Options that can execute code are NOT
// here: they are refused before this set is consulted.
const GIT_OPTION_ARGUMENTS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--attr-source',
]);

// git global options that can execute arbitrary code: `-c`/`--config-env` set
// any config git then honours (`core.pager`, `diff.external`, `alias.*`), and
// `--exec-path`/`--upload-pack`/ `--receive-pack` name a binary git runs. A
// read-only role never needs them, so they are refused by name — over-blocking
// is the correct direction here.
const GIT_EXECUTING_OPTION =
  /^(?:-c|--(?:config-env|exec-path|upload-pack|receive-pack)(?:=|$))/;

// find actions that write or run another command.
const FIND_WRITE_ACTION =
  /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

// sed/perl in-place editing: `-i`, `-i.bak`, a combined cluster (`-ni`,
// `-pi`), or the long form.
const IN_PLACE_FLAG = /^-[A-Za-z]*i/;

// Flags that write or execute under an otherwise read-only verb: `git diff
// --output=<file>` writes, `rg --pre=<command>` runs a command per file, `rg
// --hostname-bin` runs one per hostname lookup.
const WRITE_FLAG = /^--(?:output|pre|hostname-bin)(?:=|$)/;

// `|`, `||`, `&&`, `;`, a single `&` and a newline all start a new command:
// checking only the first verb of `ls & git commit -m x` left everything
// after the `&` unchecked. `&&` matches first, so it stays
// one separator, and `&>`/`&>>` land in a segment whose `>` scan blocks them.
const SEGMENT_SPLIT = /\|\||&&|[|;&\n]/;
// Both quote forms, for the redirect and verb scans: a quoted `>` is an
// argument, and a quoted command name is still that command.
const QUOTED_SPAN = /'[^']*'|"[^"]*"/g;
// Only single quotes are literal to the shell, so only they may be stripped
// before the expansion scan: `"$R"` still expands.
const SINGLE_QUOTED_SPAN = /'[^']*'/g;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function gitReadOnlyViolation(tokens: readonly string[]): string | undefined {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (token === '--') break;
    if (token.startsWith('-')) {
      if (GIT_EXECUTING_OPTION.test(token)) {
        return `git ${token} can execute code`;
      }
      i += GIT_OPTION_ARGUMENTS.has(token) ? 2 : 1;
      continue;
    }
    return READ_ONLY_GIT_SUBCOMMANDS.has(token)
      ? undefined
      : `git '${token}' is not read-only`;
  }
  return 'git without a read-only subcommand';
}

function readOnlySegmentViolation(segment: string): string | undefined {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  let i = 0;
  // Leading `VAR=value` assignments are not the command; a command
  // substitution inside one is another command and is refused.
  while (i < tokens.length && ASSIGNMENT.test(tokens[i] ?? '')) {
    const value = (tokens[i] ?? '').split('=').slice(1).join('=');
    if (value.includes('$(') || value.includes('`')) {
      return 'a command substitution is not read-only';
    }
    i += 1;
  }
  const verb = tokens[i];
  if (verb === undefined) return undefined;
  const rest = tokens.slice(i + 1);
  const writeFlag = rest.find((token) => WRITE_FLAG.test(token));
  if (writeFlag !== undefined) {
    return `${verb} ${writeFlag} writes or executes`;
  }
  if (verb === 'git') return gitReadOnlyViolation(rest);
  if (verb === 'find') {
    const action = rest.find((token) => FIND_WRITE_ACTION.test(token));
    if (action !== undefined) return `find ${action} is not read-only`;
  }
  if (verb === 'sed' || verb === 'perl') {
    const inPlace = rest.find(
      (token) =>
        token === '--in-place' ||
        token.startsWith('--in-place=') ||
        IN_PLACE_FLAG.test(token),
    );
    if (inPlace !== undefined) return `${verb} -i edits in place`;
  }
  if (!READ_ONLY_VERBS.has(verb)) {
    return `'${verb}' is not on the read-only allowlist`;
  }
  return undefined;
}

// The reason a command is not read-only, or undefined when every segment
// passes. Exported so the level's contract is unit-testable without a lane.
export function readOnlyViolation(command: string): string | undefined {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    // Quotes are stripped, not interpreted: a quoted `>` is an argument, a
    // quoted command name is still that command (and is refused).
    const bare = segment.replace(QUOTED_SPAN, ' ');
    if (bare.includes('>')) return 'redirection is not read-only';
    // Expansion is never interpreted, so it can launder another command
    // (`cat $(git commit -m x)`) or a redirect (`R='> out'; cat a $R`): a
    // substitution or any unquoted `$` is refused, fail-closed, like the
    // outside-write detector's expanded targets. Single-quoted text is
    // literal and stripped first; double quotes are not.
    const unquoted = segment.replace(SINGLE_QUOTED_SPAN, ' ');
    if (unquoted.includes('$(') || unquoted.includes('`')) {
      return 'a command substitution is not read-only';
    }
    // Process substitution runs a command too (`<(…)`; the output form
    // `>(…)` is already caught by the redirect scan above).
    if (unquoted.includes('<(')) {
      return 'a process substitution is not read-only';
    }
    if (unquoted.includes('$')) {
      return 'a shell-expanded value is not read-only';
    }
    const violation = readOnlySegmentViolation(bare);
    if (violation !== undefined) return violation;
  }
  return undefined;
}

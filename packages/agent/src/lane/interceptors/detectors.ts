// Literal-pattern detectors for destructive and network shell commands.
import { isAbsolute, resolve } from 'node:path';

const SENSITIVE_PATH = /(\.ssh\/|\.gnupg?\/|\/etc\/|passwd$|\.key$|\.pem$)/i;

// A command ends at `|`, `;`, `&` or a line break: a script runs each line as
// its own command, so `echo hi\nrm -rf /` is two commands, and a CRLF line
// ending (`\r\n`) ends one too.
function rmBlocked(command: string, workspace: string): boolean {
  const segments = command.split(/(?:^|[|;&\n\r])\s*(?=(?:rm|rmdir)\b)/i);
  for (const segment of segments) {
    const match = /^\s*(rm|rmdir)\b([^|;&\n\r]*)/i.exec(segment);
    if (match === null) continue;
    const flags = match[2] ?? '';
    if (/-[a-zA-Z]*[rf]/i.test(flags)) return true;
    // Every target token is inspected — checking only the first lets
    // `rm notes.txt /etc/passwd` through.
    const tokens = flags
      .replace(/-[a-zA-Z]+\s*/g, ' ')
      .replace(/--\S+\s*/g, ' ')
      .split(/\s+/)
      .filter((token) => token !== '');
    for (const target of tokens) {
      const resolved = isAbsolute(target)
        ? resolve(target)
        : resolve(workspace, target);
      const root = resolve(workspace);
      if (resolved !== root && !resolved.startsWith(`${root}/`)) return true;
      if (SENSITIVE_PATH.test(target)) return true;
    }
  }
  return false;
}

// Patterns that read the whole command: none of them is a gap.
const WHOLE_COMMAND_PATTERNS = [
  /\bmkfs\b/i,
  /\bshred\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

// Every other destructive shape is a HEAD verb followed, later in the SAME
// command segment (no `|`, `;`, `&` or line break between), by a chain of
// further tokens: `dd … of=/dev/`, `git clean … -f`, `chmod|chown … -R`,
// `find … -delete`, `git … push … --force|-f|+refspec`, `git … reset …
// --hard`, `git … checkout … (-- | . | -f | --force)` and `git … restore …
// (--worktree | -W)`. A regex per shape with `[^|;&\n\r]*` gaps would
// backtrack polynomially: `git push ` repeated 2000 times took 13 s and `git
// restore --staged ` repeated 2000 times 50 s, before every bash call.
//
// A chain is walked leftmost-first inside one segment — each step searches
// from the end of the previous one. That is exactly as strong as the gapped
// regex: the gap absorbs anything, so if any occurrence of a step leads to a
// full match then the LEFTMOST one does too (it leaves the most text for the
// steps after it). The walk is linear per segment. The segment handed in
// keeps its trailing separator character, because `+\S` may consume it, and
// `$` inside it is the end of the command only for the last segment.
const SEGMENT_CHAINS: ReadonlyArray<readonly RegExp[]> = [
  [/\bdd\b/gi, /\bof=\s*\/dev\//gi],
  [/\bgit\s+clean\s+/gi, /-[a-zA-Z]*f/gi],
  [/\b(chmod|chown)\b/gi, /\s-[a-zA-Z]*R/gi],
  [/\bfind\b/gi, /\s-delete\b/gi],
  [
    /\bgit\b/gi,
    /\spush\b/gi,
    /\s(--force(-with-lease|-if-includes)?\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+\S)/gi,
  ],
  [/\bgit\b/gi, /\sreset\b/gi, /\s--hard\b/gi],
  [/\bgit\b/gi, /\scheckout\b/gi, /\s(--(\s|$)|\.(\s|$)|-f\b|--force\b)/gi],
  [/\bgit\b/gi, /\srestore\b/gi, /\s(--worktree|-W)\b/gi],
];
const GIT_HEAD = /\bgit\b/gi;
const RESTORE_VERB = /\srestore\b/gi;
const STAGED_ONLY = /\s(--staged|-S)\b/gi;
const SEGMENT_HEAD = /\b(git|dd|chmod|chown|find)\b/i;
const SEGMENT_SEPARATOR = /[|;&\n\r]/g;

function chainMatches(segment: string, chain: readonly RegExp[]): boolean {
  let at = 0;
  for (const step of chain) {
    step.lastIndex = at;
    const hit = step.exec(segment);
    if (hit === null) return false;
    at = hit.index + hit[0].length;
  }
  return true;
}

// `git … restore` discards the working tree unless it is a staged-only
// restore: a restore with no `--staged`/`-S` after it. The absence is
// monotone — if some `restore` has none after it, the LAST one has none — so
// only the last `restore` needs its tail checked.
function unstagedRestore(segment: string): boolean {
  GIT_HEAD.lastIndex = 0;
  const git = GIT_HEAD.exec(segment);
  if (git === null) return false;
  RESTORE_VERB.lastIndex = git.index + git[0].length;
  let lastEnd = -1;
  for (
    let hit = RESTORE_VERB.exec(segment);
    hit !== null;
    hit = RESTORE_VERB.exec(segment)
  ) {
    lastEnd = hit.index + hit[0].length;
  }
  if (lastEnd < 0) return false;
  STAGED_ONLY.lastIndex = lastEnd;
  return STAGED_ONLY.exec(segment) === null;
}

function segmentDestructive(segment: string): boolean {
  if (!SEGMENT_HEAD.test(segment)) return false;
  return (
    SEGMENT_CHAINS.some((chain) => chainMatches(segment, chain)) ||
    unstagedRestore(segment)
  );
}

function anySegmentDestructive(command: string): boolean {
  let from = 0;
  for (;;) {
    SEGMENT_SEPARATOR.lastIndex = from;
    const separator = SEGMENT_SEPARATOR.exec(command);
    const end = separator === null ? command.length : separator.index + 1;
    if (segmentDestructive(command.slice(from, end))) return true;
    if (separator === null) return false;
    from = end;
  }
}

export function defaultIsDestructive(
  command: string,
  workspace = '/work',
): boolean {
  if (rmBlocked(command, workspace)) return true;
  return (
    WHOLE_COMMAND_PATTERNS.some((pattern) => pattern.test(command)) ||
    anySegmentDestructive(command)
  );
}

const NETWORK_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bsftp\b/i,
  /\bftp\b/i,
  /\btelnet\b/i,
  /\bnc\b/i,
];

// Literal-pattern heuristic with the same stated scope as the destructive
// matcher: python/node/npm/pip/git/openssl exfiltration bypasses
// network:none. The verbs above cover the interactive-transfer
// layer; everything else is approvals' problem.

export function isNetworkCommand(command: string): boolean {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(command));
}

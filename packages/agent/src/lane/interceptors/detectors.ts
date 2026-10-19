// Literal-pattern detectors for destructive and network shell commands.
import { isAbsolute, resolve } from 'node:path';
import { commandLead, commandWord, MAX_LEAD_WORDS } from './command-words.js';

const SENSITIVE_PATH = /(\.ssh\/|\.gnupg?\/|\/etc\/|passwd$|\.key$|\.pem$)/i;

// A command ends at `|`, `;`, `&` or a line break, and one starts after a
// subshell's `(`: a script runs each line as its own command, so `echo
// hi\nrm -rf /` is two commands, and a CRLF line ending (`\r\n`) ends one
// too. A `$(` is not split here: the approval layer unwraps substitutions,
// with its own stated depth bound.
const COMMAND_BREAK = /[|;&\n\r]|(?<!\$)\(/;

const RM_VERBS = new Set(['rm', 'rmdir']);
const FIND_EXEC = /(?:^|\s)-(?:exec|execdir|ok|okdir)(?=\s)/g;

interface Executed {
  readonly word: string;
  readonly rest: string;
  // Run by xargs or find's -exec: the paths come from input the command
  // text does not show.
  readonly bulk: boolean;
}

// The command a segment runs from `from` on (see commandLead); 'unknown'
// when its lead is too long to read. Only the words the lead can use are
// read, so a scan stays linear however long the segment is.
function executed(
  segment: string,
  from: number,
  bulk: boolean,
): Executed | 'unknown' | undefined {
  const pattern = /\S+/g;
  pattern.lastIndex = from;
  const words: string[] = [];
  const ends: number[] = [];
  for (let match = pattern.exec(segment); match !== null; ) {
    words.push(match[0]);
    ends.push(match.index + match[0].length);
    if (words.length > MAX_LEAD_WORDS) break;
    match = pattern.exec(segment);
  }
  const lead = commandLead(words);
  if (lead === 'unknown' || lead === undefined) return lead;
  return {
    word: commandWord(words[lead.index] ?? ''),
    rest: segment.slice(ends[lead.index]),
    bulk: bulk || lead.viaXargs,
  };
}

// A recursive or forced rm, or one with a target outside the workspace or
// on a sensitive path. Every target token is inspected — checking only the
// first lets `rm notes.txt /etc/passwd` through.
function rmArgumentsBlocked(args: string, workspace: string): boolean {
  if (/-[a-zA-Z]*[rf]/i.test(args)) return true;
  const tokens = args
    .replace(/-[a-zA-Z]+\s*/g, ' ')
    .replace(/--\S+\s*/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '');
  const root = resolve(workspace);
  for (const target of tokens) {
    const resolved = isAbsolute(target)
      ? resolve(target)
      : resolve(workspace, target);
    if (resolved !== root && !resolved.startsWith(`${root}/`)) return true;
    if (SENSITIVE_PATH.test(target)) return true;
  }
  return false;
}

// find's -exec family runs a command once per match: an rm there deletes
// whatever the walk finds.
function findExecRemoves(args: string): boolean {
  for (const action of args.matchAll(FIND_EXEC)) {
    const run = executed(args, action.index + action[0].length, true);
    if (run === 'unknown' || (run !== undefined && RM_VERBS.has(run.word))) {
      return true;
    }
  }
  return false;
}

// `rm`/`rmdir` wherever it is the command that runs. Run by xargs or by
// find's -exec family it is a bulk delete whatever its flags; run directly
// (behind any wrapper) its flags and targets decide.
function rmBlocked(command: string, workspace: string): boolean {
  for (const segment of command.split(COMMAND_BREAK)) {
    const run = executed(segment, 0, false);
    if (run === 'unknown') return true;
    if (run === undefined) continue;
    if (RM_VERBS.has(run.word)) {
      if (run.bulk || rmArgumentsBlocked(run.rest, workspace)) return true;
    } else if (run.word === 'find' && findExecRemoves(run.rest)) {
      return true;
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

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cdEvents, cwdAt } from './shell/cd.js';
import { expandBraces, globReaches, pathSegments } from './shell/glob.js';
import {
  ALL_REDIRECT_TARGETS,
  COPY_TARGET,
  FD_DUPLICATION,
  homeRelative,
  memoised,
  OLDPWD_PREFIXED,
  pwdRelative,
  REMOVE_MOVE_OPERANDS,
  shellUnquote,
  stripQuotes,
  TEE_TARGET,
} from './shell/lexer.js';

// Subtrees of `.kubic/` an agent may never write at all (a tool error, not an
// ask): the change journal, the audit ledger and session state.
const REFUSED_STATE_DIRS: ReadonlySet<string> = new Set([
  'journal',
  'audit',
  'sessions',
]);

// Kubic state that does not live under `<workspace>/.kubic/`. `home` is where
// the global `~/.kubic` (config.toml, the default session root) lives — default
// os.homedir(); `sessionsRoot` is the session root actually in use when it was
// overridden elsewhere, refused wholesale.
export interface ControlPlaneRoots {
  home?: string;
  sessionsRoot?: string;
}

// The path of `target` below `root` as case-folded segments, or undefined
// when it is not at or below `root`.
function segmentsBelow(root: string, target: string): string[] | undefined {
  const rel = relative(root.toLowerCase(), target.toLowerCase());
  if (rel === '') return [];
  if (isAbsolute(rel)) return undefined;
  const parts = rel.split(/[\\/]/);
  return parts[0] === '..' ? undefined : parts;
}

// Where a write target lands in Kubic's control plane, lexically: `refuse`
// for the refused state subtrees, `ask` for anything else under a Kubic state
// directory, undefined elsewhere. The state directories are the workspace's
// own `.kubic/`, and — for a target OUTSIDE the workspace — the `.kubic/` of
// every ancestor (a run from a subdirectory has the project's `.kubic/`
// above it) and `~/.kubic` (global config.toml, the session root). An
// overridden session root is refused wholesale. A leading `~/`, `$HOME/` or
// `${HOME}/` is the home directory, as the shell expands it (the
// variable forms are home paths, not plain outside-writes, which full
// access auto-approves). Case-folded, because the default
// macOS/Windows filesystems are case-insensitive (`.KUBIC/Config.toml` IS the
// config file there). Symlinks are not followed — lexical, like every shell
// detector in this module.
export function controlPlaneClass(
  workspace: string,
  target: string,
  roots: ControlPlaneRoots = {},
): 'refuse' | 'ask' | undefined {
  const path = stripQuotes(target);
  if (path === '') return undefined;
  const home = roots.home ?? homedir();
  const ws = resolve(workspace);
  const belowHome = homeRelative(path);
  const abs =
    belowHome === undefined ? resolve(ws, path) : resolve(home, belowHome);
  const literal = literalControlPlaneClass(ws, abs, home, roots);
  if (literal === 'refuse') return literal;
  // A glob (or brace list) that COULD expand into state is refused, not just
  // asked: `rm .kubic/journa?/*` names no file the scan can see, but it is the
  // journal. The bash tool's shell would expand it; we cannot, so every
  // expansion the pattern allows counts.
  return GLOB_CHARS.test(abs) && globReachesState(abs, ws, home, roots)
    ? 'refuse'
    : literal;
}

// The Kubic state directories a path can fall under: the workspace's own
// `.kubic`, and — when the path is OUTSIDE the workspace — every ancestor's and
// the home's.
function stateDirsFor(ws: string, home: string, outside: boolean): string[] {
  const dirs = [join(ws, '.kubic')];
  if (!outside) return dirs;
  for (let dir = dirname(ws); ; dir = dirname(dir)) {
    dirs.push(join(dir, '.kubic'));
    if (dirname(dir) === dir) break;
  }
  dirs.push(join(resolve(home), '.kubic'));
  return dirs;
}

function literalControlPlaneClass(
  ws: string,
  abs: string,
  home: string,
  roots: ControlPlaneRoots,
): 'refuse' | 'ask' | undefined {
  if (
    roots.sessionsRoot !== undefined &&
    segmentsBelow(resolve(roots.sessionsRoot), abs) !== undefined
  ) {
    return 'refuse';
  }
  for (const stateDir of stateDirsFor(
    ws,
    home,
    segmentsBelow(ws, abs) === undefined,
  )) {
    const parts = segmentsBelow(stateDir, abs);
    if (parts === undefined) continue;
    const sub = parts[0];
    return sub !== undefined && REFUSED_STATE_DIRS.has(sub) ? 'refuse' : 'ask';
  }
  return undefined;
}

// Glob matching for the control-plane guard. Metacharacters: `*`, `?`, `[…]`
// and `{a,b}`. Deliberately conservative: a leading `*` may match a dotfile
// (`shopt -s dotglob` exists), and an enumeration that overflows is refused
// whenever the path names `.kubic`.
const GLOB_CHARS = /[*?[{]/;
const PROTECTED_SUBS = ['journal', 'audit', 'sessions', 'config.toml', 'roles'];

function globReachesState(
  abs: string,
  ws: string,
  home: string,
  roots: ControlPlaneRoots,
): boolean {
  const variants = expandBraces(abs);
  if (variants === undefined) return /\.kubic/i.test(abs);
  const dirs = stateDirsFor(ws, home, true).map(pathSegments);
  const sessions =
    roots.sessionsRoot === undefined
      ? undefined
      : pathSegments(resolve(roots.sessionsRoot));
  return variants.some((variant) => {
    const segments = pathSegments(variant);
    return (
      dirs.some((dir) => globReaches(segments, dir, PROTECTED_SUBS)) ||
      (sessions !== undefined && globReaches(segments, sessions, undefined))
    );
  });
}

// Every path a call writes or destroys: write/edit's `path`, and for bash every
// redirect (`>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `N>`), tee and cp/mv/install
// target — the same lexical shapes the outside-write detector reads — plus the
// operands of `rm` and `mv` (deleting or moving `.kubic/journal` is tampering
// exactly like writing it; a `cp` SOURCE is only read, so it is not one).
// Redirects are scanned one by one, so a trailing `2>/dev/null` cannot mask an
// earlier target. A bash token is read the way the shell would: inner quotes
// and backslash escapes come off (`".kubic"/roles/r.md`).
//
// Each bash target yields TWO candidates and either one being control-plane is
// enough: the token as typed against the workspace, and the token resolved
// against the directory the preceding `cd`/`pushd` trail leaves (the cdEvents
// machinery the outside-write detector uses). The trail is lexical — it cannot
// tell a subshell, a conditional or a quoted `cd` from a real one — so it must
// only ever ADD a candidate; replacing the typed path with it let `(cd x);
// echo p > .kubic/journal/y` through. After a `cd` to an unknown place a
// relative token naming a `.kubic` segment is read as the workspace's own —
// fail-closed (an agent has no business in any `.kubic/journal`, so even the
// refusal class costs nothing).
const WRITE_TARGETS_MEMO = new Map<string, string[]>();
export function writeTargets(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
  home: string,
): string[] {
  if (toolName === 'write' || toolName === 'edit') {
    return typeof args.path === 'string' ? [args.path] : [];
  }
  if (toolName !== 'bash' || typeof args.command !== 'string') return [];
  const command = args.command;
  return memoised(WRITE_TARGETS_MEMO, `${workspace}\0${home}\0${command}`, () =>
    bashWriteTargets(command, workspace, home),
  );
}

function bashWriteTargets(
  command: string,
  workspace: string,
  home: string,
): string[] {
  const found: Array<{ raw: string; index: number }> = [];
  for (const match of command.matchAll(ALL_REDIRECT_TARGETS)) {
    const raw = match[2] ?? '';
    if (match[1] === '&' && FD_DUPLICATION.test(raw)) continue;
    found.push({ raw, index: match.index });
  }
  for (const tee of command.matchAll(TEE_TARGET)) {
    found.push({
      raw: (tee[1] ?? '').trim().split(/\s+/).pop() ?? '',
      index: tee.index,
    });
  }
  for (const copy of command.matchAll(COPY_TARGET)) {
    found.push({
      raw: (copy[2] ?? '').trim().split(/\s+/).pop() ?? '',
      index: copy.index,
    });
  }
  for (const removal of command.matchAll(REMOVE_MOVE_OPERANDS)) {
    for (const operand of (removal[2] ?? '').trim().split(/\s+/)) {
      if (operand !== '' && !operand.startsWith('-')) {
        found.push({ raw: operand, index: removal.index });
      }
    }
  }
  const trail = cdEvents(command, workspace, home);
  const ws = resolve(workspace);
  const targets = new Set<string>();
  for (const { raw, index } of found) {
    const token = shellUnquote(raw.replace(/[)`]+$/, ''));
    targets.add(pathAtCwd(token, ws, workspace));
    targets.add(pathAtCwd(token, cwdAt(trail, index, workspace), workspace));
  }
  return [...targets];
}

// A relative bash token joined onto the directory it is written from; shell
// expansions and absolute paths are left for controlPlaneClass. `~+`/`$PWD`
// are the directory itself. The cwd IS the workspace hands the token over
// exactly as typed. An unknown directory (`cd $X`, `~-`, `$OLDPWD`) reads a
// `.kubic` segment as the workspace's own.
function pathAtCwd(
  token: string,
  cwd: string | null,
  workspace: string,
): string {
  if (token === '' || homeRelative(token) !== undefined || isAbsolute(token)) {
    return token;
  }
  const ws = resolve(workspace);
  if (OLDPWD_PREFIXED.test(token)) return failClosedKubic(token, ws);
  const here = pwdRelative(token);
  const local = here ?? token;
  if (cwd === ws) return local;
  if (cwd !== null) return resolve(cwd, local);
  return failClosedKubic(local, ws);
}

function failClosedKubic(token: string, ws: string): string {
  const segments = token.split('/');
  const at = segments.findIndex(
    (segment) => segment.toLowerCase() === '.kubic',
  );
  return at < 0 ? token : join(ws, ...segments.slice(at));
}

// The named refusal for a write into refused control-plane state, or undefined.
// The caller returns it as a tool error without asking.
export function controlPlaneRefusal(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
  roots: ControlPlaneRoots = {},
): string | undefined {
  const home = roots.home ?? homedir();
  for (const target of writeTargets(toolName, args, workspace, home)) {
    if (controlPlaneClass(workspace, target, roots) === 'refuse') {
      return `refused: ${stripQuotes(target)} is Kubic control-plane state (.kubic/journal, .kubic/audit, .kubic/sessions) — agents may not write it`;
    }
  }
  return undefined;
}

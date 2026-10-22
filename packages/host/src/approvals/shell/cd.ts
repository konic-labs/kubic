import { isAbsolute, resolve } from 'node:path';
import {
  homeRelative,
  memoised,
  nextShellToken,
  pwdRelative,
  REDIRECT_WORD,
  shellUnquote,
} from './lexer.js';

// Shell-expanded and cd-relative write targets. The literal
// detectors see the command before bash expands it, so a target starting
// with `~` (`~/.bashrc`, `~root/x`) or `$` (`$HOME/.zshrc`, `${HOME}/x`,
// any `$VAR/...`) names a path the workspace check cannot know — it counts
// as OUTSIDE, fail-closed, never joined under the workspace. A preceding
// `cd <dir>` / `pushd <dir>` at a command start moves the cwd relative
// targets resolve against for the rest of the command: into an outside dir
// they resolve outside, and to an unknown one (bare `cd`, `cd ~`, `cd $X`,
// `cd -`, any `popd`) every later relative target fails closed.
//
// The trail is lexical, so it is only ever ONE of two candidates: a target is
// outside if it is outside as typed against the workspace OR as resolved
// against the tracked cwd. A subshell `(cd /etc)`, a conditional `false && cd
// /etc` or a `cd` quoted into an argument therefore over-triggers and can
// never hide a write (the tracked cwd alone let `(cd sub); echo x > ../y`
// through).
//
// A `cd` is only a cd at a COMMAND START: after `^`, `;`, `&`, `|`, a newline or
// `(`, then any run of the reserved words that run the next command in the
// current shell — `if`/`elif`/`then`/`do`/`else`/`while`/`until`, `{`, `!` — and
// the `command`/`builtin` wrappers. Each needs trailing whitespace, and a
// keyword in the middle of an argument (`git commit -m 'then cd /x'`) starts
// nothing. Not modelled, stated: `time cd`, `eval cd`, `bash -c 'cd …'`, and a
// subshell `cd` that undoes an earlier one. The command's own text runs to
// the next `;`, `|`, newline or `)` — and to a `&` only when it belongs to a
// redirection (`2>&1`, `>&`, `&>`), so `cd 2>&1 .kubic` keeps its directory.
const CD_COMMAND =
  /(^|[;&|\n(])[ \t]*(?:(?:if|elif|then|do|else|while|until|\{|!|command|builtin)[ \t]+)*(cd|pushd|popd)(?=$|[\s;&|)])((?:[^;&|\n)]|&(?=>)|(?<=[<>])&)*)/g;

// `end` is where the cd command's own text stops: a redirect inside it
// (`cd .. > config.toml`) is applied BEFORE the cd runs.
interface CdEvent {
  index: number;
  end: number;
  cwd: string | null;
}

// The directory a `cd` names: the first word that is neither a redirection
// (`cd 2>/dev/null .kubic`) nor an option (`-L`, `-P`, `-e`, `-@`, `--`),
// quote-aware, read the way the shell would.
function cdArgument(rest: string): string {
  let at = 0;
  for (;;) {
    const token = nextShellToken(rest, at);
    if (token === undefined) return '';
    at = token.end;
    const redirect = REDIRECT_WORD.exec(token.text);
    if (redirect !== null) {
      if (redirect[0].length === token.text.length) {
        at = nextShellToken(rest, at)?.end ?? at;
      }
      continue;
    }
    if (token.text === '--' || /^-[LPe@]+$/.test(token.text)) continue;
    return shellUnquote(token.text);
  }
}

const CD_EVENTS_MEMO = new Map<string, CdEvent[]>();
const MAX_TRACKED_CWD = 1024;

// `home` is optional: given (the control-plane detector), `cd ~` and
// `cd $HOME/x` resolve against it; absent (the outside-write detector),
// they stay an unknown place and every later relative target fails closed, as
// documented. `cd "$PWD/x"` and `cd ~+/x` are relative to the tracked cwd.
export function cdEvents(
  command: string,
  workspace: string,
  home?: string,
): CdEvent[] {
  return memoised(
    CD_EVENTS_MEMO,
    `${workspace}\0${home ?? '\u0001'}\0${command}`,
    () => computeCdEvents(command, workspace, home),
  );
}

function computeCdEvents(
  command: string,
  workspace: string,
  home?: string,
): CdEvent[] {
  const events: CdEvent[] = [];
  let cwd: string | null = resolve(workspace);
  for (const match of command.matchAll(CD_COMMAND)) {
    const dir = match[2] === 'popd' ? '' : cdArgument(match[3] ?? '');
    const belowHome = home === undefined ? undefined : homeRelative(dir);
    const belowPwd = pwdRelative(dir);
    if (home !== undefined && belowHome !== undefined) {
      cwd = resolve(home, belowHome);
    } else if (belowPwd !== undefined) {
      cwd = cwd === null ? null : resolve(cwd, belowPwd);
    } else if (
      dir === '' ||
      dir.startsWith('-') ||
      /[~$`]/.test(dir[0] ?? '')
    ) {
      cwd = null;
    } else if (isAbsolute(dir)) {
      cwd = resolve(dir);
    } else if (cwd !== null) {
      cwd = resolve(cwd, dir);
    }
    // A tracked directory past 1 KiB is not a real one (`cd a` repeated 8000
    // times built a 16 KiB path that every later target re-resolved): treated
    // as unknown, which fails closed.
    if (cwd !== null && cwd.length > MAX_TRACKED_CWD) cwd = null;
    events.push({
      index: match.index + (match[1] ?? '').length,
      end: match.index + match[0].length,
      cwd,
    });
  }
  return events;
}

// The tracked cwd at `position`: the last cd that starts before it — unless
// the position is inside that cd's own text, where it has not run yet.
export function cwdAt(
  events: readonly CdEvent[],
  position: number,
  workspace: string,
): string | null {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((events[mid]?.index ?? 0) < position) low = mid + 1;
    else high = mid;
  }
  let last = low - 1;
  if (last >= 0 && position < (events[last]?.end ?? 0)) last -= 1;
  return last < 0 ? resolve(workspace) : (events[last]?.cwd ?? null);
}

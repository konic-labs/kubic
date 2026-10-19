import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '@kubic/agent/lane/interceptors';
import type {
  CredentialLevel,
  PermissionClasses,
} from '@kubic/agent/permissions';
import {
  effectiveCredentialLevel,
  effectiveNetworkLevel,
} from '@kubic/agent/permissions';
import type { ControlPlaneRoots } from './control-plane.js';
import { controlPlaneClass, writeTargets } from './control-plane.js';
import {
  credentialAccessInCommand,
  credentialAccessInNameFilter,
  credentialAccessInPath,
} from './credentials.js';
import { isGitDirTarget } from './git-dir-target.js';
import type { Capability } from './policy.js';
import { KUBIC_STATE_WRITE } from './policy.js';
import { cdEvents, cwdAt } from './shell/cd.js';
import { gitConfigMutation, gitPushOrRemoteMutation } from './shell/git.js';
import {
  COPY_TARGET,
  FD_DUPLICATION,
  indirectCues,
  REDIRECT,
  substitutionSpans,
  TEE_TARGET,
  targetToken,
  unwrapIndirection,
} from './shell/lexer.js';
import { shellWrites } from './shell/write-commands.js';

// Trigger detection. Predicates are injected so this module stays
// free of shell parsing: the agent owns the classifiers and
// the host owns the decision. The bash detectors are a literal-pattern
// heuristic, not a sandbox: redirect outside-writes and those of the shell
// writer table, `sudo` privilege escalation, and destructive/network
// verbs behind command indirection. Indirection coverage, exactly:
// `$(…)` spans (a literal `$(…)`/`)` pairing scan — a bare `(` is ordinary
// text, so closers of other constructs can shift the pairing; the
// scan tracks at most MAX_UNWRAP_DEPTH real openers and its unmatched
// markers still consume closers, so the effective nesting threshold is
// 2x the cap — 31 levels raise, 32 do not), backtick spans, and `eval` segments are unwrapped to
// a fixpoint, so `eval $(rm -rf /)` and `echo $(echo $(rm -rf /))` raise
// too, not only the single-level `$(rm -rf /)`. What still bypasses them —
// stated, not silent: interpreter-based verbs handed over as data
// (`bash -c`, `python3 -c`, `node -e`), substitutions nested past
// ~2x MAX_UNWRAP_DEPTH, python/node/npm exfiltration under network:none,
// quoted or backslash-obfuscated verbs the literal patterns cannot see (the
// rm command word excepted: it is read as the shell reads it), whitespace
// tricks around redirection targets, and write paths that come from input
// (xargs, a file list, a variable). Detector ownership for the rest:
//   credentials overreach — the credential-path detector
//   (approvals-credentials.ts): well-known home credential locations in a
//     bash command, and the read-family tool paths onto in-workspace
//     credential files (.env*, *.pem, *.key, id_rsa*/id_ed25519*). Gated on
//     the effective `credentials` class, which enforces as `none`
//     (`allowlist` carries no list), so a credential path asks.
//   network under full — fires nothing by design (no network tool exists to
//   remove). A domain-less `allowlist` is enforced as
//     `none`: it fires like `none`, never silently
//     unrestricted.
//   sensitive reads — the filesystem read class governs reads inside the
//     workspace; credential-shaped reads are the one carve-out, raised as
//     the `credentials` capability above, not as a filesystem
//     event.
function networkGated(level: TriggerContext['network']): boolean {
  return effectiveNetworkLevel(level) === 'none';
}

// The credentials class gates its detector exactly like network: enforces
// `allowlist` as `none`, and a hand-built context that names no level reads as
// the safe default. Both keep the detector on — a credential path asks, never a
// silent grant.
function credentialGated(level: TriggerContext['credentials']): boolean {
  return effectiveCredentialLevel(level ?? 'none') === 'none';
}

export interface TriggerContext {
  workspace: string;
  network: 'none' | 'allowlist' | 'full';
  // The installed credentials class. Absent reads as `none`,
  // the safe default, so a hand-built context still challenges credential
  // paths instead of silently allowing them.
  credentials?: CredentialLevel;
  isDestructive: (command: string, workspace: string) => boolean;
  isNetworkCommand: (command: string) => boolean;
  isOutsideWorkspace: (path: string) => boolean;
  // The user's home directory: any write target under `<home>/.kubic`
  // (session state, posture.json, approvals.json) is outside-write
  // whatever the workspace is — even a workspace AT home.
  home?: string;
  requires?: string[];
  /** Kubic state roots beyond the workspace; see ControlPlaneRoots. */
  controlPlane?: ControlPlaneRoots;
}

// Package installs and fetch-and-run launchers: every one can
// run arbitrary lifecycle or downloaded code. npm/pnpm/yarn/bun installs,
// npm ci/exec/x, npx/bunx/uvx, pnpm/yarn dlx, a bare `yarn` (which
// installs), pip/pipx/uv, gem, composer, brew, apt, cargo and go.
const INSTALL =
  /(^|[|;&\s(])(npm\s+(i|install|add|clean-install|ci|exec|x)|pnpm\s+(i|install|add|dlx)|yarn(\s+(add|install|dlx|global\s+add)|(?=\s*($|[|;&)])))|bun\s+(i|install|add)|npx|bunx|uvx|pip(3)?\s+install|pipx\s+(install|run)|uv\s+(add|pip\s+install|tool\s+install)|gem\s+install|composer\s+(require|install)|brew\s+install|apt(-get)?\s+install|cargo\s+(install|add)|go\s+install)\b/i;
const DEPLOY =
  /(^|[|;&\s])(kubectl\s+(apply|create|delete|rollout)|docker\s+push|terraform\s+apply|gh\s+release\s+create)\b/i;
// Privilege escalation is a capability event on its own:
// `sudo systemctl restart …` is dangerous-shaped whatever verb follows.
// Word-boundary, anywhere in the raw command — quoted context included,
// because a literal scan cannot see into quotes — and over-triggering is
// the documented, safe direction: a raised capability becomes an ask,
// never a silent grant.
const SUDO = /\bsudo\b/;
const SHELL_EXPANDED = /^[~$]/;
// Stream pseudo-devices persist nothing: `2>/dev/null` or `> /dev/stderr`
// anywhere in a command is not an outside write (exact paths only — any
// other /dev target is a real device and still raises).
const STREAM_DEVICE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

function underKubicHome(path: string, home: string | undefined): boolean {
  if (home === undefined) return false;
  const state = resolve(home, '.kubic');
  return path === state || path.startsWith(`${state}/`);
}

function shellTargetOutside(
  target: string,
  cwd: string | null,
  ctx: TriggerContext,
): boolean {
  if (SHELL_EXPANDED.test(target)) return true;
  if (isAbsolute(target)) {
    if (STREAM_DEVICE.test(resolve(target))) return false;
    return (
      underKubicHome(resolve(target), ctx.home) ||
      ctx.isOutsideWorkspace(target)
    );
  }
  if (cwd === null) return true;
  const absolute = resolve(cwd, target);
  if (underKubicHome(absolute, ctx.home)) return true;
  // No cd moved the cwd: hand the raw token over, exactly as before.
  return ctx.isOutsideWorkspace(
    cwd === resolve(ctx.workspace) ? target : absolute,
  );
}

// The read-family arguments that name what a call opens (the same path/root
// mapping the agent confines with, CONFINED_TOOLS in the agent interceptors/confine.ts) plus
// the name FILTERS: `grep.include` and `find.nameContains` select files by
// substring, so `include: '.env'` reaches a committed `.env` without naming
// a path at all. The ask runs before that rewrite, so an
// as-typed home path is still seen here.
const READ_PATH_ARGS: Record<string, readonly string[]> = {
  read: ['path'],
  ls: ['path'],
  grep: ['root', 'include'],
  find: ['root', 'nameContains'],
};
const READ_FILTER_ARGS: ReadonlySet<string> = new Set([
  'include',
  'nameContains',
]);

export function detectTriggers(
  toolName: string,
  args: Record<string, unknown>,
  ctx: TriggerContext,
): Capability[] {
  const found: Capability[] = [];
  if (ctx.requires?.includes(toolName) === true) {
    found.push(`requires:${toolName}`);
  }
  if (toolName === 'bash' && typeof args.command === 'string') {
    const command = args.command;
    // One span scan per command: the target detectors trim a lifted token's
    // substitution closer by span-closer index, and the indirection cues
    // below reuse the same spans.
    const spans = substitutionSpans(command);
    const spanClosers = new Set(spans.map((span) => span.closer));
    if (ctx.isDestructive(command, ctx.workspace))
      found.push('destructive-shell');
    if (networkGated(ctx.network) && ctx.isNetworkCommand(command))
      found.push('network');
    if (gitPushOrRemoteMutation(command)) found.push('git-push');
    // `git config` sets rewrite `.git/config` with no
    // file-write target, so the write-target detectors never fire.
    if (gitConfigMutation(command)) found.push(KUBIC_STATE_WRITE);
    if (INSTALL.test(command)) found.push('install');
    if (DEPLOY.test(command)) found.push('deploy');
    // Every write target (redirect, tee, cp/mv/install, the writer table)
    // goes through one check: resolved against the cwd a preceding
    // `cd`/`pushd` left behind, failing closed on shell-expanded prefixes.
    const cdTrail = cdEvents(command, ctx.workspace);
    const typedCwd = resolve(ctx.workspace);
    // Outside if EITHER the path as typed OR its cd-tracked resolution is
    // (see the cd notes above).
    const outsidePath = (target: string, start: number): boolean => {
      if (target === '') return false;
      if (shellTargetOutside(target, typedCwd, ctx)) return true;
      const tracked = cwdAt(cdTrail, start, ctx.workspace);
      return tracked !== typedCwd && shellTargetOutside(target, tracked, ctx);
    };
    // Scanned targets arrive raw: quotes always come off, and a lifted token
    // also loses its substitution closer (targetToken) — so `> "/etc/cron.d/x"`
    // and `echo $(cp a /etc/b)` cannot dodge the outside check while a plain
    // literal `)`/`]` stays part of the path.
    const outside = (raw: string, end: number, start: number): boolean =>
      outsidePath(targetToken(raw, end, spanClosers), start);
    const targets: Array<[string, number, number]> = [];
    for (const redirect of command.matchAll(REDIRECT)) {
      const raw = redirect[2] ?? '';
      if (redirect[1]?.endsWith('&') === true && FD_DUPLICATION.test(raw)) {
        continue;
      }
      targets.push([raw, redirect.index + redirect[0].length, redirect.index]);
    }
    // Shell-side writes by another name: a tee or cp/mv/install word anywhere
    // has its last argument checked (see TEE_TARGET), with the closer trim
    // scoped to lifted tokens.
    for (const tee of command.matchAll(TEE_TARGET)) {
      targets.push([tee[1] ?? '', tee.index + tee[0].length, tee.index]);
    }
    for (const copy of command.matchAll(COPY_TARGET)) {
      targets.push([copy[2] ?? '', copy.index + copy[0].length, copy.index]);
    }
    // Every other writer, by the command table (a delete is destructive-shell's
    // to raise, not outside-write's).
    if (
      targets.some(([raw, end, start]) => outside(raw, end, start)) ||
      shellWrites(command).some(
        (write) => !write.removal && outsidePath(write.path, write.at),
      )
    ) {
      found.push('outside-write');
    }
    // Privilege escalation and command indirection: sudo is a
    // capability event wherever it sits, and a destructive/network verb
    // behind $(…) (nested spans included), backticks, or eval raises the
    // UNDERLYING capability — never a new one — instead of hiding behind
    // the matcher layer's stated indirection gap.
    if (SUDO.test(command)) {
      found.push('privilege-escalation');
    }
    for (const nested of indirectCues(command, spans)) {
      const payload = unwrapIndirection(nested);
      if (payload === '') continue;
      if (ctx.isDestructive(payload, ctx.workspace)) {
        found.push('destructive-shell');
      }
      if (networkGated(ctx.network) && ctx.isNetworkCommand(payload)) {
        found.push('network');
      }
    }
    if (
      credentialGated(ctx.credentials) &&
      credentialAccessInCommand(command) !== undefined
    ) {
      found.push('credentials');
    }
  }
  // In-workspace credential files: confinement already keeps
  // the tools inside the workspace, but `.env*` and key material committed
  // there are exactly the files the class is about.
  const readArgs = READ_PATH_ARGS[toolName];
  if (readArgs !== undefined && credentialGated(ctx.credentials)) {
    for (const arg of readArgs) {
      const value = args[arg];
      if (typeof value !== 'string') continue;
      const hit = READ_FILTER_ARGS.has(arg)
        ? (credentialAccessInPath(value) ?? credentialAccessInNameFilter(value))
        : credentialAccessInPath(value);
      if (hit !== undefined) {
        found.push('credentials');
        break;
      }
    }
  }
  if (
    (toolName === 'write' || toolName === 'edit') &&
    typeof args.path === 'string'
  ) {
    if (
      underKubicHome(resolve(ctx.workspace, args.path), ctx.home) ||
      ctx.isOutsideWorkspace(args.path)
    ) {
      found.push('outside-write');
    }
  }
  // A write under the workspace's own `.git/` (hooks, config)
  // is control-plane-grade tampering — a planted hook runs on the host's
  // later git commands — so it raises the same always-ask capability.
  if (
    writeTargets(
      toolName,
      args,
      ctx.workspace,
      ctx.controlPlane?.home ?? homedir(),
    ).some(
      (target) =>
        controlPlaneClass(ctx.workspace, target, ctx.controlPlane) !==
          undefined || isGitDirTarget(ctx.workspace, target),
    )
  ) {
    found.push(KUBIC_STATE_WRITE);
  }
  return [...new Set(found)];
}

// The trigger context the shipped default evaluates capabilities with: the
// same classifiers the agent guards use, so the approval
// decision and the guard that blocks the call can never disagree.
export function triggerContextFor(
  classes: PermissionClasses,
  workspace: string,
  controlPlaneOrHome?: ControlPlaneRoots | string,
  home?: string,
  // Role-sourced approval obligations — tool names
  // that always challenge under the resolved role. Optional, so the
  // existing call shapes (and their tests) are untouched.
  requires?: string[],
): TriggerContext {
  // HEAD passes the control plane as the third argument; the
  // branch passes the user's home string there (tests rely on both shapes),
  // so the third argument is either. `home` is always set — `~`-expanded
  // targets are checked against it.
  const controlPlane =
    typeof controlPlaneOrHome === 'string' ? undefined : controlPlaneOrHome;
  const resolvedHome =
    typeof controlPlaneOrHome === 'string'
      ? controlPlaneOrHome
      : (home ?? homedir());
  return {
    workspace,
    home: resolvedHome,
    ...(controlPlane === undefined ? {} : { controlPlane }),
    ...(requires === undefined ? {} : { requires: [...requires] }),
    network: classes.network,
    credentials: classes.credentials,
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path: string) =>
      confinePath(workspace, path).rewritten,
  };
}

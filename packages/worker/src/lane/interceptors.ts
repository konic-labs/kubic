// Policy interceptors on the solo lane (issue #15, slice C; §40.1 mechanism 3).
// Registered as separate harness hooks so chaining, first-block-wins, and
// throw-becomes-block are the harness's real semantics, not ours. Every
// handler is fail-closed: a policy exception blocks with its message.
//
// Enforcement map (what each class means at this layer):
//   filesystem — tool allowlist (slice B) + path confine below. Symlinks
//     are NOT resolved (lexical confine only, same limit as the exec seam);
//     a workspace symlink pointing outside is a known escape, documented
//     here instead of silently "handled".
//   shell true — bash present, destructive commands blocked.
//   shell read-only-allowlist — bash present, destructive AND network
//     commands blocked.
//   shell false — bash absent via allowlist.
//   network none (and a domain-less allowlist, enforced as none — issue
//     #166) — network-command verbs blocked in bash. full
//     change nothing at the tool layer (documented, not silent): there is
//     no network tool to remove, and shell:true can still curl. The flag
//     is consumed by approval triggers (issue #16).
//   git/credentials — NO tool-layer enforcement today (no git/credential
//     tools exist yet; git arrives with issue #19). The flags are stored
//     validated config consumed by approval triggers (issue #16), never
//     silently dropped.
// The destructive matcher is a literal-pattern heuristic, not a sandbox:
// it sees the command string only, so $CMD indirection, backslash escapes,
// and eval-obfuscation bypass THIS guard (stated, not silent). Since issue
// #131 the trigger layer raises on the cheap shapes this guard misses — a
// destructive/network verb inside $(…)/backticks/eval and `sudo` anywhere
// become approval asks instead of slipping through silently — but the
// detection is still literal-pattern: python/node/npm exfiltration, quoted
// or backslash-obfuscated verbs, and whitespace tricks around redirect
// targets stay unenforceable, documented as such in host/approvals.ts.
import { isAbsolute, join, resolve } from 'node:path';
import {
  effectiveNetworkLevel,
  type NetworkLevel,
  type ShellLevel,
} from '../../../agents/src/policy.js';
import { readRootFor } from '../../../exec/src/read-roots.js';
import type { Hooks, JsonValue } from '../pi-boundary.js';

export interface PolicyTrigger {
  kind: 'max_tool_calls';
  toolName: string;
  count: number;
}

export interface PolicyInterceptorOptions {
  workspace: string;
  maxToolCalls?: number;
  onTrigger?: (trigger: PolicyTrigger) => void;
  shell?: ShellLevel;
  network?: NetworkLevel;
  // Read-only confinement exception (issue #173; §29.3): the directories
  // (or files) of the skills advertised with absolute paths outside the
  // workspace. Only the `read` tool may open a path inside one; write,
  // edit, ls, find and grep keep re-rooting every outside path.
  readRoots?: readonly string[];
  isDestructive?: (command: string, workspace: string) => boolean;
  // Approval decider (issue #16, owned by the host). Consulted for every
  // call after the budget gate: denials block; approvals let the call
  // through. Only challenged approvals (a real capability was raised and
  // granted) stand down the destructive/network/confine guards for that
  // exact toolCallId — an unchallenged fast-path keeps every guard up.
  // The type lives here (not in host) because the worker cannot import
  // host; the host adapts its ApprovalService to it.
  approve?: (call: ApprovalCall) => Promise<ApprovalAskVerdict>;
}

export interface ApprovalCall {
  toolName: string;
  args: Record<string, JsonValue>;
  toolCallId: string;
}

export type ApprovalAskVerdict =
  | { approved: true; challenged: boolean }
  | { approved: false; reason: string };

const SENSITIVE_PATH = /(\.ssh\/|\.gnupg?\/|\/etc\/|passwd$|\.key$|\.pem$)/i;

function rmBlocked(command: string, workspace: string): boolean {
  const segments = command.split(/(?:^|[|;&])\s*(?=(?:rm|rmdir)\b)/i);
  for (const segment of segments) {
    const match = /^\s*(rm|rmdir)\b([^|;&]*)/i.exec(segment);
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

const DESTRUCTIVE_PATTERNS = [
  /\bmkfs\b/i,
  /\bdd\b[^|;&]*\bof=\s*\/dev\//i,
  /\bshred\b/i,
  /\bgit\s+clean\s+[^|;&]*-[a-zA-Z]*f/i,
  /\b(chmod|chown)\b[^|;&]*\s-[a-zA-Z]*R/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

export function defaultIsDestructive(
  command: string,
  workspace = '/work',
): boolean {
  if (rmBlocked(command, workspace)) return true;
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
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
// network:none today. The verbs above cover the interactive-transfer
// layer; everything else is approvals' problem (issue #16).

export function isNetworkCommand(command: string): boolean {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(command));
}

export function confinePath(
  workspace: string,
  path: string,
): { confined: string; rewritten: boolean } {
  const root = resolve(workspace);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (resolved === root || resolved.startsWith(`${root}/`))
    return { confined: resolved, rewritten: false };
  // Re-root under the workspace. The rewritten path is operator-visible in
  // the tool call, so a same-named workspace file can confuse but never
  // silently serve an outside file.
  const tail = resolved
    .split('/')
    .filter((part) => part !== '' && part !== '..' && part !== '.');
  return { confined: join(root, tail.join('/')), rewritten: true };
}

// Reasons persist into the trajectory, so commands and raw errors are
// truncated and secret-shaped values redacted before they become blocks.
export function redactReason(value: string): string {
  const short = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return short.replace(
    /((?:token|password|passwd|secret|api[-_]?key|bearer|authorization|private[-_]?key)\s*(?:[=:]\s*|\s+))\S+/gi,
    '$1[REDACTED]',
  );
}

function block(reason: string): {
  block: { reason: string; terminate: false };
} {
  return { block: { reason: redactReason(reason), terminate: false as const } };
}

function failClosed<T>(
  fn: () => T | Promise<T>,
): Promise<T | { block: { reason: string; terminate: false } }> {
  try {
    const value = fn();
    return value instanceof Promise
      ? value.catch((error: unknown) =>
          block(error instanceof Error ? error.message : String(error)),
        )
      : Promise.resolve(value);
  } catch (error: unknown) {
    return Promise.resolve(
      block(error instanceof Error ? error.message : String(error)),
    );
  }
}

// Tools whose path-like args are confined. read/write/edit/ls take `path`,
// find/grep take `root`.
const CONFINED_TOOLS: Record<string, string[]> = {
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  ls: ['path'],
  find: ['root'],
  grep: ['root'],
};

function confineArgs(
  toolName: string,
  args: Record<string, JsonValue>,
  workspace: string,
): Record<string, JsonValue> | undefined {
  const keys = CONFINED_TOOLS[toolName];
  if (keys === undefined) return undefined;
  let rewritten = false;
  const next = { ...args };
  for (const key of keys) {
    const value = next[key];
    if (typeof value !== 'string') continue;
    const { confined, rewritten: hit } = confinePath(workspace, value);
    if (hit) {
      next[key] = confined;
      rewritten = true;
    }
  }
  return rewritten ? next : undefined;
}

export function registerPolicyInterceptors(
  hooks: Hooks,
  options: PolicyInterceptorOptions,
): () => void {
  const isDestructive = options.isDestructive ?? defaultIsDestructive;
  const readRoots = (options.readRoots ?? []).map((root) => resolve(root));
  // Tool calls a real challenge cleared. Guards below stand down for
  // exactly these ids — never by tool name or pattern. Unchallenged
  // fast-path calls never enter this set, so #15 guards stay up for them.
  // Capped FIFO: harness toolCallIds are unique per call, but an
  // unbounded set across a long lane lifetime is a leak; eviction only
  // drops stale ids whose calls already ran.
  const approvedCalls = new Map<string, number>();
  const APPROVED_CALLS_CAP = 512;
  const markApproved = (toolCallId: string): void => {
    approvedCalls.set(toolCallId, Date.now());
    if (approvedCalls.size > APPROVED_CALLS_CAP) {
      const oldest = approvedCalls.keys().next();
      if (!oldest.done) approvedCalls.delete(oldest.value);
    }
  };
  // Budget first: every attempt counts, even one a later handler blocks.
  let calls = 0;
  let triggered = false;
  const off: Array<() => void> = [];

  if (options.maxToolCalls !== undefined) {
    const max = options.maxToolCalls;
    off.push(
      hooks.on('before_tool', (event) =>
        failClosed(() => {
          calls += 1;
          if (calls <= max) return undefined;
          if (!triggered) {
            triggered = true;
            try {
              options.onTrigger?.({
                kind: 'max_tool_calls',
                toolName: event.toolName,
                count: calls,
              });
            } catch {
              // A throwing trigger callback must not mask the block.
            }
          }
          return block(`maxToolCalls (${max}) exceeded`);
        }),
      ),
    );
  }

  off.push(
    hooks.on('before_tool', (event) =>
      failClosed(async () => {
        if (options.approve === undefined) return undefined;
        const verdict = await options.approve({
          toolName: event.toolName,
          args: event.args,
          toolCallId: event.toolCallId,
        });
        if (verdict.approved) {
          if (verdict.challenged) markApproved(event.toolCallId);
          return undefined;
        }
        return block(`not approved: ${verdict.reason}`);
      }),
    ),
  );

  off.push(
    hooks.on('before_tool', (event) =>
      failClosed(() => {
        if (approvedCalls.has(event.toolCallId)) return undefined;
        if (event.toolName !== 'bash') return undefined;
        const command =
          typeof event.args.command === 'string' ? event.args.command : '';
        if (isDestructive(command, options.workspace)) {
          return block(`destructive command blocked: ${command}`);
        }
        // A domain-less `allowlist` allows nothing (issue #166): it is
        // enforced as `none`, never as the unrestricted `full`.
        const network =
          options.network === undefined
            ? undefined
            : effectiveNetworkLevel(options.network);
        if (
          (network === 'none' || options.shell === 'read-only-allowlist') &&
          isNetworkCommand(command)
        ) {
          const declared = options.network ?? 'none';
          return block(
            `network command blocked (network: ${declared}${declared === 'none' ? '' : ', enforced as none'}): ${command}`,
          );
        }
        return undefined;
      }),
    ),
  );

  off.push(
    hooks.on('before_tool', (event) =>
      failClosed(() => {
        if (approvedCalls.has(event.toolCallId)) return undefined;
        if (
          event.toolName === 'read' &&
          typeof event.args.path === 'string' &&
          readRootFor(readRoots, event.args.path) !== undefined
        ) {
          return undefined;
        }
        const confined = confineArgs(
          event.toolName,
          event.args,
          options.workspace,
        );
        if (confined === undefined) return undefined;
        return { args: confined };
      }),
    ),
  );

  return () => {
    for (const remove of off) remove();
  };
}

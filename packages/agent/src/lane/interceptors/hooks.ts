// The policy hooks the lane registers on every tool task: confinement, the
// shell and network classes, the destructive guard and the approval ask.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { scanSecrets } from '@kubic/core/secret-scan';
import { readRootFor } from '@kubic/exec/read-roots';
import { effectiveNetworkLevel } from '../../permissions.js';
import type { HookRegistration, JsonValue } from '../../pi-boundary.js';
import { hook, ToolTask } from '../../pi-boundary.js';
import { confineArgs } from './confine.js';
import { defaultIsDestructive } from './detectors.js';
import { isNetworkCommand } from './network.js';
import { readOnlyViolation } from './read-only.js';
import { redactReason, redactSecrets } from './redact.js';
import type { PolicyInterceptorOptions, ToolHookCalls } from './types.js';

// A pi-durable block verdict: the harness turns the string into the error
// result the model sees (`Tool call blocked: …`).
function block(reason: string): { block: string } {
  return { block: redactReason(reason) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failClosed<T>(
  fn: () => T | Promise<T>,
): Promise<T | { block: string }> {
  try {
    const value = fn();
    return value instanceof Promise
      ? value.catch((error: unknown) => block(errorText(error)))
      : Promise.resolve(value);
  } catch (error: unknown) {
    return Promise.resolve(block(errorText(error)));
  }
}

// The canonical form of a call's arguments for the stand-down key: JSON key
// order is not stable across providers, so every object is sorted before
// hashing, and the hash keeps the map small whatever a tool's arguments carry
// (a write's content can be megabytes).
function canonicalArgsHash(args: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(sort(args)))
    .digest('hex')
    .slice(0, 16);
}

// The lane's policy interception as ordered `ToolTask` hooks.
// Order is correctness: the approval seat first, then the admin hooks (on
// the arguments the operator allowed), then the destructive/network guard,
// then the confine rewrite last — and the harness skips every later hook
// once a block is returned. Each
// registration is one handler, so the order of this array IS the chain
// order.
//
// State lifetime: the approved call ids live in THIS invocation's closure — call the factory once per
// lane boot (boot.ts builds its `kubic.policy` extension fresh on every
// boot). Installing one returned array into two boots would share them, so
// the factory deliberately never keeps state across calls: two invocations,
// even with the same options object, start clean.
export function policyInterceptorHooks(
  options: PolicyInterceptorOptions,
): HookRegistration[] {
  const stands = standDowns();
  // The shell calls the operator rewrote, by call id — the
  // result says what ran, so neither the model nor the transcript takes the
  // proposed command's output for its own. Capped like the stand-downs.
  const editedCalls = new Map<string, { from: string; to: string }>();
  return [
    approvalHook(options, stands, editedCalls),
    ...(options.toolHooks?.before === undefined
      ? []
      : [adminBeforeHook(options.toolHooks.before)]),
    shellGuardHook(options, stands),
    confineHook(options, stands),
    // Last in the chain: a stand-down is SPENT once the call
    // it was granted for has run its guards. Registered after every guard
    // so all of them saw it, and deleting by call id because the confine
    // guard may have rewritten the arguments a later hook receives.
    hook(ToolTask, {
      beforeTool: (call) =>
        failClosed(() => {
          stands.consume(call.id);
          return undefined;
        }),
    }),
    ...(options.redactToolOutput === undefined
      ? []
      : [toolOutputScanHook(options.redactToolOutput)]),
    // After the scan, so an admin hook reads the output the model reads.
    ...(options.toolHooks?.after === undefined
      ? []
      : [adminAfterHook(options.toolHooks.after)]),
  ];
}

// An admin hook's refusal blocks the call with the reason it gave; a hook
// that throws blocks it too (fail closed).
function adminBeforeHook(
  before: NonNullable<ToolHookCalls['before']>,
): HookRegistration {
  return hook(ToolTask, {
    beforeTool: (call) =>
      failClosed(async () => {
        const reason = await before({
          toolName: call.name,
          args: call.arguments as Record<string, unknown>,
        });
        return reason === undefined ? undefined : block(reason);
      }),
  });
}

// An after-tool admin hook observes the result; its failure is its own
// (audited by the host) and never changes what the model reads.
function adminAfterHook(
  after: NonNullable<ToolHookCalls['after']>,
): HookRegistration {
  return hook(ToolTask, {
    afterTool: async (call, result) => {
      const output = (result.output ?? [])
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n');
      try {
        await after({
          toolName: call.name,
          args: call.arguments as Record<string, unknown>,
          isError: result.isError === true,
          output,
        });
      } catch {
        // Observation only.
      }
      return undefined;
    },
  });
}

// The model never reads a secret a tool returned: every text part of the
// result is scanned after the tool runs, before the result entry is
// committed — so neither the model's context nor the stored transcript holds
// it — and the caller hears how many values were redacted.
function toolOutputScanHook(
  notify: (toolName: string, found: number) => void,
): HookRegistration {
  return hook(ToolTask, {
    afterTool: (call, result) => {
      if (result.output === undefined) return undefined;
      let found = 0;
      const output = result.output.map((part) => {
        if (part.type !== 'text') return part;
        const scanned = scanSecrets(part.text);
        found += scanned.found;
        return scanned.found === 0 ? part : { ...part, text: scanned.text };
      });
      if (found === 0) return undefined;
      notify(call.name, found);
      return { ...result, output };
    },
  });
}

const APPROVED_CALLS_CAP = 512;

interface StandDowns {
  mark(callId: string, args: Record<string, unknown>): void;
  isApproved(callId: string, args: Record<string, unknown>): boolean;
  consume(callId: string): void;
}

// Tool calls a real challenge cleared, keyed by the call id AND the exact
// arguments it was cleared for. The id alone is not an
// identity: it comes from the provider (an OpenAI-compatible server can
// repeat `call_0` or send `""`), so an approved `rm -rf x` must not stand
// the guards down for a later, different call that reuses the id. Each
// entry is SPENT when that call's beforeTool chain finishes, so a repeated
// call asks again instead of inheriting the stand-down. Capped FIFO over
// call ids: a call whose chain never finished (a thrown guard) is evicted
// eventually, and an entry can only ever stand down the exact id+args pair
// it was granted for. Deliberately in-memory: a resumed process re-asks,
// never inherits a stand-down it did not grant.
function standDowns(): StandDowns {
  const approvedCalls = new Map<string, Set<string>>();
  return {
    mark: (callId, args) => {
      // An empty id is never a stand-down key (defence in depth: the harness
      // always assigns one, but a broken provider must not win).
      if (callId === '') return;
      const keys = approvedCalls.get(callId) ?? new Set<string>();
      keys.add(canonicalArgsHash(args));
      // Re-insert so the FIFO evicts the least recently marked call id.
      approvedCalls.delete(callId);
      approvedCalls.set(callId, keys);
      while (approvedCalls.size > APPROVED_CALLS_CAP) {
        const oldest = approvedCalls.keys().next();
        if (oldest.done) break;
        approvedCalls.delete(oldest.value);
      }
    },
    isApproved: (callId, args) => {
      // No hash for the common case: a call id with no entry is the fast path.
      const keys = callId === '' ? undefined : approvedCalls.get(callId);
      return keys !== undefined && keys.has(canonicalArgsHash(args));
    },
    // Every entry of one call id. Deletion is by id, not by the args hash:
    // the confine guard rewrites `call.arguments`, so the arguments a later
    // hook receives are not the ones the stand-down was stored for.
    consume: (callId) => {
      approvedCalls.delete(callId);
    },
  };
}

function approvalHook(
  options: PolicyInterceptorOptions,
  stands: StandDowns,
  editedCalls: Map<string, { from: string; to: string }>,
): HookRegistration {
  return hook(ToolTask, {
    // The ask is awaited here, BEFORE the harness commits the tool's
    // intent: a crash while the user decides re-asks on resume instead of
    // resuming an unapproved execution.
    beforeTool: (call) =>
      failClosed(async () => {
        if (options.approve === undefined) return undefined;
        const verdict = await options.approve({
          toolName: call.name,
          args: call.arguments,
          toolCallId: call.id,
        });
        if (verdict.approved) {
          // An edited call runs as edited — the later guards see
          // (and a stand-down covers) exactly the arguments that were judged.
          const args = verdict.arguments ?? call.arguments;
          if (verdict.challenged) stands.mark(call.id, args);
          if (
            verdict.arguments !== undefined &&
            call.name === 'bash' &&
            call.id !== ''
          ) {
            editedCalls.set(call.id, {
              from: String(call.arguments.command ?? ''),
              to: String(verdict.arguments.command ?? ''),
            });
            while (editedCalls.size > APPROVED_CALLS_CAP) {
              const oldest = editedCalls.keys().next();
              if (oldest.done) break;
              editedCalls.delete(oldest.value);
            }
          }
          return verdict.arguments === undefined
            ? undefined
            : { arguments: verdict.arguments as Record<string, JsonValue> };
        }
        return block(`not approved: ${verdict.reason}`);
      }),
    // An edited call's result opens with what actually ran.
    afterTool: (call, result) => {
      const edit = editedCalls.get(call.id);
      if (edit === undefined) return undefined;
      editedCalls.delete(call.id);
      if (result.output === undefined) return undefined;
      return {
        ...result,
        output: [
          {
            type: 'text',
            text: `[edited by the user — ran: ${redactSecrets(edit.to)} (proposed: ${redactSecrets(edit.from)})]\n`,
          },
          ...result.output,
        ],
      };
    },
  });
}

// The shell guard: destructive commands, network commands under a network
// class that forbids them, and the read-only allowlist.
function shellGuardHook(
  options: PolicyInterceptorOptions,
  stands: StandDowns,
): HookRegistration {
  const isDestructive = options.isDestructive ?? defaultIsDestructive;
  return hook(ToolTask, {
    beforeTool: (call) =>
      failClosed(() => {
        if (stands.isApproved(call.id, call.arguments)) return undefined;
        if (call.name !== 'bash') return undefined;
        const command =
          typeof call.arguments.command === 'string'
            ? call.arguments.command
            : '';
        if (isDestructive(command, options.workspace)) {
          return block(`destructive command blocked: ${command}`);
        }
        // A domain-less `allowlist` allows nothing: it is
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
        // A read-only role gets the explicit allowlist,
        // not the full shell minus network.
        if (options.shell === 'read-only-allowlist') {
          const violation = readOnlyViolation(command);
          if (violation !== undefined) {
            return block(`read-only shell blocked: ${violation}: ${command}`);
          }
        }
        return undefined;
      }),
  });
}

// The confine rewrite: tool paths resolved inside the workspace, except a
// read under one of the extra read roots.
function confineHook(
  options: PolicyInterceptorOptions,
  stands: StandDowns,
): HookRegistration {
  const readRoots = (options.readRoots ?? []).map((root) => resolve(root));
  return hook(ToolTask, {
    beforeTool: (call) =>
      failClosed(() => {
        if (stands.isApproved(call.id, call.arguments)) return undefined;
        if (
          call.name === 'read' &&
          typeof call.arguments.path === 'string' &&
          readRootFor(readRoots, call.arguments.path) !== undefined
        ) {
          return undefined;
        }
        const confined = confineArgs(
          call.name,
          call.arguments,
          options.workspace,
        );
        if (confined === undefined) return undefined;
        // Pi's `JsonObject` (the hook's input) and the harness's own
        // document `JsonObject` (the hook's result) are one JSON value
        // under two copies of the alias; the rewrite replaced only
        // strings, and the harness re-validates it against the schema.
        return { arguments: confined as Record<string, JsonValue> };
      }),
  });
}

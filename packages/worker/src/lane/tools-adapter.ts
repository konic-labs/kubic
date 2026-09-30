// Kubic operations as Pi harness tools (issue #11, slice A; issue #168).
// One AgentHarnessTool per OPERATIONS entry: name/description/replay map
// straight across (§20.2 alignment is structural, not coincidental).
// Issue #168 (§37.5, §40.3): every tool carries its real parameter schema
// from ops/registry.ts (OPERATION_PARAMETERS — the single source) and
// declares json_schema constrained sampling with strict 'prefer', so capable
// providers enforce valid arguments; Pi validates against the same schema
// before execute, and Kubic's validators stay authoritative after it.
// read/bash/grep results reach the model as plain text under a short header
// (raw lines, never JSON-escaped); the other ops keep their JSON result.
// Structured op errors are returned as model-readable content (Pi's own
// tools report exit codes the same way); only unexpected throws propagate
// to the harness as faults.

import type { CheckpointStore, ExecutionEnv } from '../../../exec/src/env.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import type { BashResult } from '../ops/bash.js';
import type { GrepResult } from '../ops/grep.js';
import type { ReadResult } from '../ops/read.js';
import {
  callOperation,
  OPERATION_PARAMETERS,
  OPERATIONS,
  type OperationName,
} from '../ops/registry.js';
import type { MemoStore, OpContext, ToolInvocation } from '../ops/types.js';
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
} from '../pi-boundary.js';
import type { OperationKillRegistry } from './abort.js';

export interface KubicToolContext {
  env: ExecutionEnv;
  sessionId: string;
  agentId: string;
  memos: MemoStore;
  kills: OperationKillRegistry;
  checkpointStore?: CheckpointStore;
  // Session journal for interception (issue #17): when set, write/edit
  // record every mutation. Wired by the lane in slice D; absent in tests
  // and journal-free contexts.
  journal?: FileJournalStore;
}

function toInvocation(pi: AgentHarnessToolInvocation): ToolInvocation {
  return {
    invocationId: pi.invocationId,
    operationId: pi.operationId,
    turnId: pi.turnId,
    getMemo: (name: string) => pi.getMemo(name),
    setMemo: (name: string, value) => pi.setMemo(name, value),
    // Check-then-set, not atomic: safe because the harness never executes
    // the same toolCallId concurrently (single-flight drive). If an op ever
    // relies on this for never-replay gating under concurrent retry, route
    // it through an atomic primitive instead.
    memoOnce: async (name, candidate) => {
      const existing = await pi.getMemo(name);
      if (existing !== undefined) return existing;
      await pi.setMemo(name, candidate);
      return candidate;
    },
  };
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function withNewline(text: string): string {
  return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
}

// `[read <path>: lines a-b of N]` + the raw lines. `of at least N` when the
// read was cut (totalLines is then a lower bound); `more: offset=K` whenever
// lines remain past the window, so the model knows how to continue. A
// refusal or cut notice (issue #176) rides the same header — or replaces
// the empty-window text, since "no lines at offset K" would misname a line
// that exists but exceeds the output cap.
export function renderReadText(result: ReadResult): string {
  const shown = lineCount(result.content);
  const total = `${result.truncated ? 'at least ' : ''}${result.totalLines}`;
  if (shown === 0) {
    if (result.notice !== undefined) {
      return `[read ${result.path}: ${result.notice}]\n`;
    }
    return result.totalLines === 0 && !result.truncated
      ? `[read ${result.path}: empty (0 lines)]\n`
      : `[read ${result.path}: no lines at offset ${result.offset} (file has ${total} lines)]\n`;
  }
  const end = result.offset + shown - 1;
  const more =
    result.truncated || end < result.totalLines
      ? `; more: offset=${end + 1}`
      : '';
  const notice = result.notice === undefined ? '' : `; ${result.notice}`;
  return `[read ${result.path}: lines ${result.offset}-${end} of ${total}${more}${notice}]\n${withNewline(result.content)}`;
}

// `[grep /<pattern>/: N matches]` + one `path:line: text` per match.
export function renderGrepText(result: GrepResult): string {
  const count = result.matches.length;
  // A cut result names WHICH cap stopped it (issue #172): the walk's entry
  // cap with the directory it exhausted, the depth cap with where it pruned,
  // or maxMatches — the model narrows differently for each.
  const cut = result.truncated
    ? `, truncated (narrow pattern, root or include)${
        result.notice === undefined ? '' : `: ${result.notice}`
      }`
    : '';
  const head = `[grep /${result.pattern}/: ${count} ${count === 1 ? 'match' : 'matches'}${cut}]\n`;
  return (
    head +
    result.matches
      .map((match) => `${match.path}:${match.line}: ${match.text}\n`)
      .join('')
  );
}

// `[bash exit <code> (<shell>)]` + the raw streams, each under its own
// marker; flags name a timeout, an abort, or a clipped stream.
export function renderBashText(result: BashResult): string {
  const flags = [
    result.timedOut ? 'timed out' : undefined,
    result.aborted ? 'aborted' : undefined,
    result.truncated ? 'output truncated' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  const head = `[bash exit ${result.exitCode ?? 'none'} (${result.shell})${
    flags.length === 0 ? '' : `, ${flags.join(', ')}`
  }]\n`;
  const streams = [
    result.stdout.length === 0
      ? ''
      : `--- stdout ---\n${withNewline(result.stdout)}`,
    result.stderr.length === 0
      ? ''
      : `--- stderr ---\n${withNewline(result.stderr)}`,
  ].join('');
  return head + (streams.length === 0 ? '(no output)\n' : streams);
}

// The model-facing text for a successful op result.
export function renderToolText(name: string, result: unknown): string {
  if (name === 'read') return renderReadText(result as ReadResult);
  if (name === 'grep') return renderGrepText(result as GrepResult);
  if (name === 'bash') return renderBashText(result as BashResult);
  return JSON.stringify(result);
}

export function kubicToolsToPiTools(): AgentHarnessTool<KubicToolContext>[] {
  return Object.values(OPERATIONS).map((op) => ({
    name: op.name,
    label: op.name,
    description: op.description,
    parameters: OPERATION_PARAMETERS[op.name as OperationName],
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    replay: op.replay,
    execute: async (toolCallId, params, onUpdate, toolContext, invocation) => {
      const inv = toInvocation(invocation);
      const ctx: OpContext = {
        env: toolContext.env,
        sessionId: toolContext.sessionId,
        agentId: toolContext.agentId,
        checkpointStore: toolContext.checkpointStore,
        // The harness toolCallId is the journal's attribution key (issue
        // #17): without it, intercepted entries could not name their call.
        toolCallId,
        journal: toolContext.journal,
        trackHandle: (kill) => toolContext.kills.track(inv.operationId, kill),
        onUpdate: (snapshot) =>
          onUpdate({
            content: [{ type: 'text', text: JSON.stringify(snapshot) }],
            details: { kind: 'streaming', toolCallId },
          }),
      };
      const out = await callOperation(op.name, params, inv, ctx);
      if (out.ok) {
        return {
          content: [
            { type: 'text', text: renderToolText(op.name, out.result) },
          ],
          details: { ok: true, toolCallId, invocationId: inv.invocationId },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `error ${out.error.code}: ${out.error.message}`,
          },
        ],
        details: { ok: false, toolCallId, code: out.error.code },
      };
    },
  }));
}

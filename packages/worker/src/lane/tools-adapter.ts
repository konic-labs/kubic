// Kubic operations as Pi harness tools (issue #11, slice A).
// One AgentHarnessTool per OPERATIONS entry: name/description/replay map
// straight across (§20.2 alignment is structural, not coincidental).
// Argument strictness stays in Kubic validators — the Pi parameter schema is
// intentionally a loose record until provider-level constrainedSampling
// lands with issue #20. Structured op errors are returned as model-readable
// content (Pi's own tools report exit codes the same way); only unexpected
// throws propagate to the harness as faults.

import type { CheckpointStore, ExecutionEnv } from '../../../exec/src/env.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import { callOperation, OPERATIONS } from '../ops/registry.js';
import type { MemoStore, OpContext, ToolInvocation } from '../ops/types.js';
import {
  type AgentHarnessTool,
  type AgentHarnessToolInvocation,
  Type,
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

export function kubicToolsToPiTools(): AgentHarnessTool<KubicToolContext>[] {
  return Object.values(OPERATIONS).map((op) => ({
    name: op.name,
    label: op.name,
    description: op.description,
    parameters: Type.Record(Type.String(), Type.Unknown()),
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
          content: [{ type: 'text', text: JSON.stringify(out.result) }],
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

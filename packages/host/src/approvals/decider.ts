// The decider behind the installed approval ask: one challenged tool call
// judged against control-plane refusal, the detected capabilities, full
// access, stored answers, the policy route, autoApprove and the answer seat.

import type {
  ApprovalAskVerdict,
  ApprovalCall,
} from '@kubic/agent/lane/interceptors';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { ControlPlaneRoots } from './control-plane.js';
import { controlPlaneRefusal } from './control-plane.js';
import type {
  InstalledPolicyPosture,
  PolicyInput,
  RecordedApprovalDeny,
} from './installed-policy.js';
import { NO_ANSWER_SURFACE_REASON } from './installed-policy.js';
import type { Capability } from './policy.js';
import { ALLOW_TURN_EDITS, ALWAYS_ASK, KUBIC_STATE_WRITE } from './policy.js';
import { approvalPreview } from './preview.js';
import {
  approvalKey,
  approvalRequestDisplay,
  boundedNote,
  MAX_APPROVAL_EDITS,
  summarizeRequest,
} from './request.js';
import type { ApprovalService } from './service.js';
import { detectTriggers, triggerContextFor } from './triggers.js';

export interface DecisionRecorder {
  ledgerDir: string;
  sessionId: string;
  audit: (
    toolName: string,
    trigger: string,
    decision:
      | { approved: true; by?: string }
      | { approved: false; reason: string },
    fullAccess: boolean,
    // What an approval's record says beyond `approved` (an
    // edited command names both).
    note?: string,
  ) => void;
  deny: (
    capability: string,
    toolName: string,
    reason: string,
  ) => { approved: false; reason: string };
  denials: () => RecordedApprovalDeny[];
}

// Everything the decider reads, plus the one cell it writes: whether the
// operator approved this turn's edits at once.
export interface Decider {
  input: PolicyInput;
  posture: InstalledPolicyPosture;
  service: ApprovalService;
  recorder: DecisionRecorder;
  guardPosture: () => void;
  controlPlane: ControlPlaneRoots;
  turnEdits: boolean;
}

// The operator approved this turn's edits at once (`A`): an
// edit or write whose challenge is its role obligation runs without asking
// until the turn ends — never latched, never another capability (a path
// outside the workspace raises `outside-write`, which still asks).
function turnEditable(toolName: string, capability: string): boolean {
  return (
    (toolName === 'edit' || toolName === 'write') &&
    capability === `requires:${toolName}`
  );
}

export async function judge(
  d: Decider,
  call: ApprovalCall,
  edits: number,
): Promise<ApprovalAskVerdict> {
  // A posture.json change made mid-session is refused and
  // restored before this call is judged.
  d.guardPosture();
  // Refused control-plane state: a tool error before any
  // posture is consulted — full access included — and never an ask.
  const refusal = controlPlaneRefusal(
    call.toolName,
    call.args,
    d.input.workspace,
    d.controlPlane,
  );
  if (refusal !== undefined) {
    return d.recorder.deny(KUBIC_STATE_WRITE, call.toolName, refusal);
  }
  const detected = detectTriggers(
    call.toolName,
    call.args,
    // The role's approval obligations challenge
    // here, alongside the class-derived triggers.
    triggerContextFor(
      d.posture.classes,
      d.input.workspace,
      d.controlPlane,
      undefined,
      d.input.requires,
    ),
  );
  let capabilities = detected;
  if (d.posture.fullAccess && d.posture.route === 'ask-user') {
    capabilities = waiveForFullAccess(d, call, detected);
    if (capabilities.length === 0) {
      // An untriggered call waived nothing, so it is not challenged and no
      // guard needs standing down.
      return { approved: true, challenged: detected.length > 0 };
    }
  }
  if (capabilities.length === 0) return { approved: true, challenged: false };
  for (const capability of capabilities) {
    const refused = await decideCapability(d, call, capability, edits);
    if (refused !== undefined) return refused;
  }
  return { approved: true, challenged: true };
}

// Full access never answers an always-ask capability:
// those still go through the ask; everything else is approved.
function waiveForFullAccess(
  d: Decider,
  call: ApprovalCall,
  detected: Capability[],
): Capability[] {
  // Record exactly what full access waived — one record per
  // capability, posture 'full-access' — and nothing at all for an
  // untriggered call. The single `trigger:full-access` row this replaces
  // was written for EVERY call, read and ls included: one fsync per tool
  // call, and a trail that could not name what ran unapproved.
  for (const capability of detected) {
    if (ALWAYS_ASK.has(capability)) continue;
    d.recorder.audit(
      call.toolName,
      capability,
      { approved: true, by: 'full-access' },
      true,
    );
  }
  return detected.filter((capability) => ALWAYS_ASK.has(capability));
}

// One challenged capability. Resolves undefined when it is approved (the
// call moves on to its next capability), or the verdict that ends the call.
async function decideCapability(
  d: Decider,
  call: ApprovalCall,
  capability: Capability,
  edits: number,
): Promise<ApprovalAskVerdict | undefined> {
  const key = approvalKey(call.toolName, capability, call.args);
  // A stored decision (a real answer, from a surface that has one) wins:
  // first-answer-latched, exactly like every other approval path.
  // A stored approval granted without justification does not survive
  // requireJustification (the service's own staleness rule): it
  // re-enters the policy path below instead of being replayed.
  const stored = d.service.decided(key);
  const decided =
    stored?.approved === true &&
    d.posture.requireJustification &&
    stored.justified !== true
      ? undefined
      : stored;
  if (decided !== undefined) {
    if (!decided.approved) {
      return d.recorder.deny(capability, call.toolName, decided.reason);
    }
    d.recorder.audit(
      call.toolName,
      capability,
      { approved: true, by: decided.by },
      false,
    );
    return undefined;
  }
  // route=deny refuses everything challenged — autoApprove entries never
  // apply under it, which is exactly what `kubic doctor` says (`route=deny
  // ignores autoApprove`); the lane never approves them.
  if (d.posture.route === 'deny') {
    // Configured refusal: named as the route, never as a timeout.
    const reason = `denied by policy route (capability: ${capability})`;
    return d.recorder.deny(capability, call.toolName, reason);
  }
  // This turn's edits were approved at once.
  if (d.turnEdits && turnEditable(call.toolName, capability)) {
    d.recorder.audit(
      call.toolName,
      capability,
      { approved: true, by: ALLOW_TURN_EDITS },
      false,
    );
    return undefined;
  }
  // Config autoApprove: explicit-only, decided by
  // the service (which also enforces requireJustification), and
  // consulted BEFORE the no-surface refusal, so a headless run honours it
  // exactly like an interactive one. An always-ask capability never takes
  // this branch: it behaves as if autoApprove were empty for
  // it — the seat below, or the instant no-surface refusal — instead of
  // waiting out maxPendingMs with no seat to answer.
  if (
    !ALWAYS_ASK.has(capability) &&
    d.posture.autoApprove.includes(capability)
  ) {
    const verdict = await d.service.request({
      key,
      capability,
      toolName: call.toolName,
      summary: summarizeRequest(call.toolName, capability, call.args),
    });
    if (!verdict.approved) {
      return d.recorder.deny(capability, call.toolName, verdict.reason);
    }
    d.recorder.audit(
      call.toolName,
      capability,
      { approved: true, by: verdict.by },
      false,
    );
    return undefined;
  }
  // An answer seat is attached: the TUI is a command with a
  // user attached, so the verdict can be collected instead of refused.
  // The wait is bounded by maxPendingMs inside the service — a seat that
  // never answers denies on timeout rather than hanging the turn.
  if (d.input.answer !== undefined) {
    return askSeat(d, call, capability, key, edits);
  }
  // NO ANSWER SURFACE IS INSTALLED — `kubic run` has no TTY, and a `kubic
  // tui` whose seat was never attached cannot collect a verdict either.
  // Waiting maxPendingMs for an answer that cannot arrive would be a
  // silent hang and a 60s stall per dangerous call; the honest default is
  // to refuse immediately and RECORD the refusal, so the composition root
  // ends the run as approval_denied (exit 4, — this refusal carries no
  // timeout marker) instead of reporting a success the user never
  // approved. The refusal is deliberately NOT
  // persisted: it is a missing surface, not a user decision, and a later
  // overlay must still be able to ask about the same operation.
  const reason = `${NO_ANSWER_SURFACE_REASON} (capability: ${capability})`;
  return d.recorder.deny(capability, call.toolName, reason);
}

async function askSeat(
  d: Decider,
  call: ApprovalCall,
  capability: Capability,
  key: string,
  edits: number,
): Promise<ApprovalAskVerdict | undefined> {
  // An ask carries the file change it would make.
  const preview = approvalPreview(
    createNodeFileBridge(d.input.workspace),
    call.toolName,
    call.args,
  );
  // The answers an ask can take beyond allow/deny.
  const editable =
    call.toolName === 'bash' && typeof call.args.command === 'string';
  const batchable = turnEditable(call.toolName, capability);
  const verdict = await d.service.request({
    key,
    capability,
    toolName: call.toolName,
    ...approvalRequestDisplay(call.toolName, capability, call.args),
    ...(preview === undefined ? {} : { preview }),
    ...(editable ? { editable: true } : {}),
    ...(batchable ? { batchable: true } : {}),
  });
  if (!verdict.approved) {
    // A denial's reason reaches the model (a user's comment rides it):
    // bounded like every other summary.
    const reason = boundedNote(verdict.reason);
    return d.recorder.deny(capability, call.toolName, reason);
  }
  // The operator rewrote the command. The rewrite is a new
  // call: judged again from the start (a destructive edit asks again),
  // and what runs is the rewrite.
  if (verdict.edited !== undefined && editable) {
    return judgeEdited(d, call, capability, verdict.edited.command, edits);
  }
  if (verdict.by === ALLOW_TURN_EDITS && batchable) d.turnEdits = true;
  d.recorder.audit(
    call.toolName,
    capability,
    { approved: true, by: verdict.by },
    false,
  );
  return undefined;
}

async function judgeEdited(
  d: Decider,
  call: ApprovalCall,
  capability: Capability,
  command: string,
  edits: number,
): Promise<ApprovalAskVerdict> {
  if (command.trim() === '') {
    return d.recorder.deny(
      capability,
      call.toolName,
      'denied by the user: the edited command is empty',
    );
  }
  if (edits >= MAX_APPROVAL_EDITS) {
    return d.recorder.deny(
      capability,
      call.toolName,
      `denied: one call was edited more than ${MAX_APPROVAL_EDITS} times`,
    );
  }
  d.recorder.audit(
    call.toolName,
    capability,
    { approved: true, by: 'user-edit' },
    false,
    boundedNote(
      redactSecretShapes(
        `edited by the user: ${String(call.args.command)} → ${command}`,
      ),
    ),
  );
  const editedArgs = { ...call.args, command };
  const next = await judge(d, { ...call, args: editedArgs }, edits + 1);
  return next.approved
    ? { ...next, arguments: next.arguments ?? editedArgs }
    : next;
}

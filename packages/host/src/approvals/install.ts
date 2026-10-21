import { basename } from 'node:path';
import type { ToolContribution } from '@kubic/agent/lane/wrap';
import { withTelemetry } from '@kubic/agent/lane/wrap';
import {
  appendToLedger,
  auditLedgerDirFor,
  decisionAudit,
  postureChangedAudit,
} from '../audit/index.js';
import type { ControlPlaneRoots } from './control-plane.js';
import type { Decider, DecisionRecorder } from './decider.js';
import { judge } from './decider.js';
import { recordFullAccessChange } from './full-access.js';
import type {
  ApprovalAsk,
  InstalledPolicy,
  InstalledPolicyPosture,
  PolicyInput,
  RecordedApprovalDeny,
} from './installed-policy.js';
import { installedPolicyPosture } from './installed-policy.js';
import { validatePolicy } from './policy.js';
import { ApprovalService } from './service.js';
import type { AccessPosture } from './stores.js';
import { FileApprovalStore } from './stores.js';

export function installPolicy(input: PolicyInput): InstalledPolicy {
  const store =
    input.sessionDir === undefined
      ? undefined
      : new FileApprovalStore(input.sessionDir);
  // The full-access posture is resolved ONCE, here,
  // at session boot — from what the explicit flag or `sessions create
  // --dangerously-skip-approvals` recorded — and kept in memory. posture.json
  // is never re-read to decide an ask.
  const bootPosture: AccessPosture = store?.loadPosture() ?? {
    fullAccess: false,
  };
  const posture = installedPolicyPosture(input, bootPosture);
  const service = approvalServiceFor(input, posture, store);
  const recorder = decisionRecorder(input);
  const grants = new Map<string, string[]>();
  const guardPosture = postureGuard(input, store, bootPosture, recorder);
  const decider: Decider = {
    input,
    posture,
    service,
    recorder,
    guardPosture,
    controlPlane: controlPlaneRoots(input),
    turnEdits: false,
    grant: (toolCallId, capabilities) => {
      grants.set(toolCallId, [...capabilities]);
      // Bounded like the stand-downs: the oldest grant goes first.
      if (grants.size > GRANTS_KEPT) {
        grants.delete(grants.keys().next().value as string);
      }
    },
  };
  const ask: ApprovalAsk = (call) => judge(decider, call, 0);
  return {
    classes: posture.classes,
    interceptors: {
      workspace: input.workspace,
      shell: posture.classes.shell,
      network: posture.classes.network,
      approve: ask,
    },
    contributions: policyContributions(input),
    posture,
    denials: () => recorder.denials(),
    ask,
    // True exactly when the ask auto-approves every challenged call as full
    // access — the SAME live posture the ask consults, so the status bar's OFF
    // indicator cannot drift from the policy.
    approvalsSkipped: () => posture.fullAccess && posture.route === 'ask-user',
    setFullAccess: fullAccessToggle(
      input,
      store,
      posture,
      bootPosture,
      recorder.sessionId,
    ),
    settle: guardPosture,
    endTurn: () => {
      decider.turnEdits = false;
    },
    editsApprovedThisTurn: () => decider.turnEdits,
    grantsFor: (toolCallId) => grants.get(toolCallId) ?? [],
  };
}

const GRANTS_KEPT = 512;

function approvalServiceFor(
  input: PolicyInput,
  posture: InstalledPolicyPosture,
  store: FileApprovalStore | undefined,
): ApprovalService {
  return new ApprovalService({
    policy: validatePolicy({
      route: posture.route,
      sessionScoped: posture.sessionScoped,
      maxPendingMs: posture.maxPendingMs,
      autoApprove: posture.autoApprove,
      requireJustification: posture.requireJustification,
    }),
    ...(store === undefined ? {} : { store }),
    // The seat's ask is the service's awaitAnswer: the service races it
    // against its own maxPendingMs bound, so a seat that never resolves
    // denies on timeout (never hangs) exactly like the headless path.
    ...(input.answer === undefined ? {} : { awaitAnswer: input.answer }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

// Audit ledger: every resolved ask appends one record to the REPO
// ledger: <main checkout>/.kubic/audit,
// resolved once here with the same resolver `kubic audit` reads through,
// so a run from a subdirectory or a linked worktree writes where the
// reader looks. Best-effort by contract — a failed write (or a malformed
// record) goes to onAuditError, never into the approval decision.
function decisionRecorder(input: PolicyInput): DecisionRecorder {
  const ledgerDir = auditLedgerDirFor(input.workspace);
  const sessionId =
    input.sessionId ??
    (input.sessionDir === undefined ? '' : basename(input.sessionDir));
  const refused: RecordedApprovalDeny[] = [];
  const audit: DecisionRecorder['audit'] = (
    toolName,
    trigger,
    decision,
    fullAccess,
    note,
  ) => {
    const onError = input.onAuditError ?? (() => undefined);
    try {
      const model =
        typeof input.model === 'function' ? input.model() : input.model;
      // The thinking level at record time, like the model.
      const thinking =
        typeof input.thinking === 'function'
          ? input.thinking()
          : input.thinking;
      appendToLedger(
        ledgerDir,
        decisionAudit({
          sessionId,
          toolName,
          trigger,
          workspace: input.workspace,
          ...(model === undefined ? {} : { model }),
          ...(thinking === undefined ? {} : { thinking }),
          ...(input.base === undefined ? {} : { base: input.base }),
          approved: decision.approved,
          ...(decision.approved
            ? decision.by === undefined
              ? {}
              : { by: decision.by }
            : { reason: decision.reason }),
          ...(note === undefined ? {} : { note }),
          posture: fullAccess ? 'full-access' : 'approvals',
        }),
        onError,
      );
    } catch (error) {
      try {
        onError(error instanceof Error ? error.message : String(error));
      } catch {
        // A throwing error sink must not reach the approval either.
      }
    }
  };
  return {
    ledgerDir,
    sessionId,
    audit,
    deny: (capability, toolName, reason) => {
      refused.push({ capability, toolName, reason });
      audit(toolName, capability, { approved: false, reason }, false);
      return { approved: false, reason };
    },
    denials: () => [...refused],
  };
}

// Kubic state beyond the workspace: the global home and the
// session root this lane actually writes.
function controlPlaneRoots(input: PolicyInput): ControlPlaneRoots {
  return {
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.sessionsRoot === undefined
      ? {}
      : { sessionsRoot: input.sessionsRoot }),
  };
}

// The in-session toggle. `posture.fullAccess` is the
// LIVE cell the ask reads on every call, so flipping it takes effect on
// the very next challenged call; `bootPosture` is re-based with it, so the
// Guard sees the operator's own change rather than a foreign one and
// does not restore the file underneath them.
function fullAccessToggle(
  input: PolicyInput,
  store: FileApprovalStore | undefined,
  posture: InstalledPolicyPosture,
  bootPosture: AccessPosture,
  sessionId: string,
): (enabled: boolean, by: string) => AccessPosture {
  return (enabled, by) => {
    // ONE writer and ONE clock read: the helper writes
    // the file and the audit row through the same shapes the CLI paths use,
    // and the record it returns is what the live cell and the guard's
    // baseline are re-based on — never a second `Date.now()`.
    const recorded = recordFullAccessChange({
      enabled,
      by,
      sessionId,
      workspace: input.workspace,
      ...(store === undefined ? {} : { store }),
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(input.onAuditError === undefined
        ? {}
        : { onAuditError: input.onAuditError }),
    });
    posture.fullAccess = recorded.fullAccess;
    bootPosture.fullAccess = recorded.fullAccess;
    bootPosture.enabledAt = recorded.enabledAt;
    bootPosture.enabledBy = recorded.enabledBy;
    return recorded;
  };
}

// A posture.json change made DURING the session is refused:
// the file is restored to the boot posture (so a later resume does not
// inherit it) and the change is recorded once in the ledger. Checked on
// every ask and on settle(), never consulted for the decision itself.
function postureGuard(
  input: PolicyInput,
  store: FileApprovalStore | undefined,
  bootPosture: AccessPosture,
  recorder: DecisionRecorder,
): () => void {
  let postureChangeRecorded = false;
  return () => {
    if (store === undefined) return;
    let current: AccessPosture;
    try {
      current = store.loadPosture();
    } catch {
      return;
    }
    if (
      current.fullAccess === bootPosture.fullAccess &&
      current.enabledAt === bootPosture.enabledAt &&
      current.enabledBy === bootPosture.enabledBy
    ) {
      return;
    }
    const onError = input.onAuditError ?? (() => undefined);
    try {
      store.savePosture(bootPosture);
    } catch (error) {
      onError(
        `posture restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (postureChangeRecorded) return;
    postureChangeRecorded = true;
    appendToLedger(
      recorder.ledgerDir,
      postureChangedAudit({
        sessionId: recorder.sessionId,
        workspace: input.workspace,
        bootFullAccess: bootPosture.fullAccess,
        observedFullAccess: current.fullAccess === true,
      }),
      onError,
    );
  };
}

function policyContributions(input: PolicyInput): ToolContribution[] {
  const contributions = [...(input.contributions ?? [])];
  if (input.telemetry !== undefined) {
    // Outermost by construction: appended last, so it wraps whatever the
    // caller contributed and the lane's own permission(core) stack.
    contributions.push(withTelemetry(input.telemetry));
  }
  return contributions;
}

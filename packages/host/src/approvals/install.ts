import { basename } from 'node:path';
import type {
  ApprovalAskVerdict,
  ApprovalCall,
} from '@kubic/agent/lane/interceptors';
import { withTelemetry } from '@kubic/agent/lane/wrap';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  appendToLedger,
  auditLedgerDirFor,
  decisionAudit,
  postureChangedAudit,
} from '../policy/audit-ledger.js';
import type { ControlPlaneRoots } from './control-plane.js';
import { controlPlaneRefusal } from './control-plane.js';
import { recordFullAccessChange } from './full-access.js';
import type {
  ApprovalAsk,
  InstalledPolicy,
  PolicyInput,
  RecordedApprovalDeny,
} from './installed-policy.js';
import {
  installedPolicyPosture,
  NO_ANSWER_SURFACE_REASON,
} from './installed-policy.js';
import {
  ALLOW_TURN_EDITS,
  ALWAYS_ASK,
  KUBIC_STATE_WRITE,
  validatePolicy,
} from './policy.js';
import { approvalPreview } from './preview.js';
import {
  approvalKey,
  approvalRequestDisplay,
  boundedNote,
  MAX_APPROVAL_EDITS,
  summarizeRequest,
} from './request.js';
import { ApprovalService } from './service.js';
import type { AccessPosture } from './stores.js';
import { FileApprovalStore } from './stores.js';
import { detectTriggers, triggerContextFor } from './triggers.js';

export function installPolicy(input: PolicyInput): InstalledPolicy {
  const denials: RecordedApprovalDeny[] = [];
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
  const service = new ApprovalService({
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
  // Audit ledger: every resolved ask appends one record to the REPO
  // ledger: <main checkout>/.kubic/audit,
  // resolved once here with the same resolver `kubic audit` reads through,
  // so a run from a subdirectory or a linked worktree writes where the
  // reader looks. Best-effort by contract — a failed write (or a malformed
  // record) goes to onAuditError, never into the approval decision.
  const ledgerDir = auditLedgerDirFor(input.workspace);
  const auditSessionId =
    input.sessionId ??
    (input.sessionDir === undefined ? '' : basename(input.sessionDir));
  const audit = (
    toolName: string,
    trigger: string,
    decision:
      | { approved: true; by?: string }
      | { approved: false; reason: string },
    fullAccess: boolean,
    // What an approval's record says beyond `approved` (an
    // edited command names both).
    note?: string,
  ): void => {
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
          sessionId: auditSessionId,
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
  // Kubic state beyond the workspace: the global home and the
  // session root this lane actually writes.
  const controlPlane: ControlPlaneRoots = {
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.sessionsRoot === undefined
      ? {}
      : { sessionsRoot: input.sessionsRoot }),
  };
  const deny = (
    capability: string,
    toolName: string,
    reason: string,
  ): { approved: false; reason: string } => {
    denials.push({ capability, toolName, reason });
    audit(toolName, capability, { approved: false, reason }, false);
    return { approved: false, reason };
  };
  // True exactly when the ask auto-approves every challenged call as full
  // access — the SAME live posture the ask consults, so the status bar's OFF
  // indicator cannot drift from the policy.
  const approvalsSkipped = (): boolean =>
    posture.fullAccess && posture.route === 'ask-user';
  // The in-session toggle. `posture.fullAccess` is the
  // LIVE cell the ask reads on every call, so flipping it takes effect on
  // the very next challenged call; `bootPosture` is re-based with it, so the
  // Guard sees the operator's own change rather than a foreign one and
  // does not restore the file underneath them.
  const setFullAccess = (enabled: boolean, by: string): AccessPosture => {
    // ONE writer and ONE clock read: the helper writes
    // the file and the audit row through the same shapes the CLI paths use,
    // and the record it returns is what the live cell and the guard's
    // baseline are re-based on — never a second `Date.now()`.
    const recorded = recordFullAccessChange({
      enabled,
      by,
      sessionId: auditSessionId,
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
  // A posture.json change made DURING the session is refused:
  // the file is restored to the boot posture (so a later resume does not
  // inherit it) and the change is recorded once in the ledger. Checked on
  // every ask and on settle(), never consulted for the decision itself.
  let postureChangeRecorded = false;
  const guardPosture = (): void => {
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
      ledgerDir,
      postureChangedAudit({
        sessionId: auditSessionId,
        workspace: input.workspace,
        bootFullAccess: bootPosture.fullAccess,
        observedFullAccess: current.fullAccess === true,
      }),
      onError,
    );
  };
  // The operator approved this turn's edits at once (`A`): an
  // edit or write whose challenge is its role obligation runs without asking
  // until the turn ends — never latched, never another capability (a path
  // outside the workspace raises `outside-write`, which still asks).
  let turnEdits = false;
  const turnEditable = (toolName: string, capability: string): boolean =>
    (toolName === 'edit' || toolName === 'write') &&
    capability === `requires:${toolName}`;
  const ask: ApprovalAsk = (call) => judge(call, 0);
  const judge = async (
    call: ApprovalCall,
    edits: number,
  ): Promise<ApprovalAskVerdict> => {
    // A posture.json change made mid-session is refused and
    // restored before this call is judged.
    guardPosture();
    // Refused control-plane state: a tool error before any
    // posture is consulted — full access included — and never an ask.
    const refusal = controlPlaneRefusal(
      call.toolName,
      call.args,
      input.workspace,
      controlPlane,
    );
    if (refusal !== undefined) {
      return deny(KUBIC_STATE_WRITE, call.toolName, refusal);
    }
    const detected = detectTriggers(
      call.toolName,
      call.args,
      // The role's approval obligations challenge
      // here, alongside the class-derived triggers.
      triggerContextFor(
        posture.classes,
        input.workspace,
        controlPlane,
        undefined,
        input.requires,
      ),
    );
    let capabilities = detected;
    if (posture.fullAccess && posture.route === 'ask-user') {
      // Full access never answers an always-ask capability:
      // those still go through the ask below; everything else is approved.
      capabilities = detected.filter((capability) =>
        ALWAYS_ASK.has(capability),
      );
      // Record exactly what full access waived — one record per
      // capability, posture 'full-access' — and nothing at all for an
      // untriggered call. The single `trigger:full-access` row this replaces
      // was written for EVERY call, read and ls included: one fsync per tool
      // call, and a trail that could not name what ran unapproved.
      for (const capability of detected) {
        if (ALWAYS_ASK.has(capability)) continue;
        audit(
          call.toolName,
          capability,
          { approved: true, by: 'full-access' },
          true,
        );
      }
      if (capabilities.length === 0) {
        // An untriggered call waived nothing, so it is not challenged and no
        // guard needs standing down.
        return { approved: true, challenged: detected.length > 0 };
      }
    }
    if (capabilities.length === 0) return { approved: true, challenged: false };
    for (const capability of capabilities) {
      const key = approvalKey(call.toolName, capability, call.args);
      // A stored decision (a real answer, from a surface that has one) wins:
      // first-answer-latched, exactly like every other approval path.
      // A stored approval granted without justification does not survive
      // requireJustification (the service's own staleness rule): it
      // re-enters the policy path below instead of being replayed.
      const stored = service.decided(key);
      const decided =
        stored?.approved === true &&
        posture.requireJustification &&
        stored.justified !== true
          ? undefined
          : stored;
      if (decided !== undefined) {
        if (!decided.approved) {
          return deny(capability, call.toolName, decided.reason);
        }
        audit(
          call.toolName,
          capability,
          { approved: true, by: decided.by },
          false,
        );
        continue;
      }
      // route=deny refuses everything challenged — autoApprove entries never
      // apply under it, which is exactly what `kubic doctor` says (`route=deny
      // ignores autoApprove`); the lane never approves them.
      if (posture.route === 'deny') {
        // Configured refusal: named as the route, never as a timeout.
        const reason = `denied by policy route (capability: ${capability})`;
        return deny(capability, call.toolName, reason);
      }
      // This turn's edits were approved at once.
      if (turnEdits && turnEditable(call.toolName, capability)) {
        audit(
          call.toolName,
          capability,
          { approved: true, by: ALLOW_TURN_EDITS },
          false,
        );
        continue;
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
        posture.autoApprove.includes(capability)
      ) {
        const verdict = await service.request({
          key,
          capability,
          toolName: call.toolName,
          summary: summarizeRequest(call.toolName, capability, call.args),
        });
        if (!verdict.approved) {
          return deny(capability, call.toolName, verdict.reason);
        }
        audit(
          call.toolName,
          capability,
          { approved: true, by: verdict.by },
          false,
        );
        continue;
      }
      // An answer seat is attached: the TUI is a command with a
      // user attached, so the verdict can be collected instead of refused.
      // The wait is bounded by maxPendingMs inside the service — a seat that
      // never answers denies on timeout rather than hanging the turn.
      if (input.answer !== undefined) {
        // An ask carries the file change it would make.
        const preview = approvalPreview(
          createNodeFileBridge(input.workspace),
          call.toolName,
          call.args,
        );
        // The answers an ask can take beyond allow/deny.
        const editable =
          call.toolName === 'bash' && typeof call.args.command === 'string';
        const batchable = turnEditable(call.toolName, capability);
        const verdict = await service.request({
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
          return deny(capability, call.toolName, reason);
        }
        // The operator rewrote the command. The rewrite is a new
        // call: judged again from the start (a destructive edit asks again),
        // and what runs is the rewrite.
        if (verdict.edited !== undefined && editable) {
          const command = verdict.edited.command;
          if (command.trim() === '') {
            return deny(
              capability,
              call.toolName,
              'denied by the user: the edited command is empty',
            );
          }
          if (edits >= MAX_APPROVAL_EDITS) {
            return deny(
              capability,
              call.toolName,
              `denied: one call was edited more than ${MAX_APPROVAL_EDITS} times`,
            );
          }
          audit(
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
          const next = await judge({ ...call, args: editedArgs }, edits + 1);
          return next.approved
            ? { ...next, arguments: next.arguments ?? editedArgs }
            : next;
        }
        if (verdict.by === ALLOW_TURN_EDITS && batchable) turnEdits = true;
        audit(
          call.toolName,
          capability,
          { approved: true, by: verdict.by },
          false,
        );
        continue;
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
      return deny(capability, call.toolName, reason);
    }
    return { approved: true, challenged: true };
  };
  const contributions = [...(input.contributions ?? [])];
  if (input.telemetry !== undefined) {
    // Outermost by construction: appended last, so it wraps whatever the
    // caller contributed and the lane's own permission(core) stack.
    contributions.push(withTelemetry(input.telemetry));
  }
  return {
    classes: posture.classes,
    interceptors: {
      workspace: input.workspace,
      shell: posture.classes.shell,
      network: posture.classes.network,
      approve: ask,
    },
    contributions,
    posture,
    denials: () => [...denials],
    ask,
    approvalsSkipped,
    setFullAccess,
    settle: guardPosture,
    endTurn: () => {
      turnEdits = false;
    },
    editsApprovedThisTurn: () => turnEdits,
  };
}

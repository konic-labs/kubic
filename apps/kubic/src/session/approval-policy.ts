// The boot's policy step: full access when asked for, the base revision,
// and the approval policy the lane runs under.

import { join } from 'node:path';
import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import type { ExecutionEnv } from '@kubic/exec/env';
import {
  DEFAULT_MAX_PENDING_MS,
  enableSessionFullAccess,
  installPolicy,
  webhookApprovalBroker,
} from '@kubic/host/approvals';
import { resolveRunBaseRevision } from '@kubic/host/audit';
import { effectiveRoleClasses } from '@kubic/host/roles';
import type { SessionBoot } from './bootstrap.js';

// The approval policy the lane runs under — the same derivation doctor
// reports. Config classes replace the documented DEFAULT_PERMISSIONS; the
// destructive, network and confine guards and the approval ask are
// installed either way, so a run with no config is not a run with no
// policy.
export async function installBootPolicy(
  boot: SessionBoot,
  env: ExecutionEnv,
): Promise<void> {
  const { config, request, root, sinks } = boot;
  const id = boot.id;
  // The explicit flag enables full access for THIS session through the one
  // host enable path (posture.json, one audit row, the shared warning)
  // BEFORE the policy is installed, so the lane boots under the posture
  // the user asked for.
  const grant =
    request.dangerouslySkipApprovals === true
      ? enableSessionFullAccess({
          sessionDir: join(root, id),
          sessionId: id,
          command: request.command,
          workspace: env.cwd,
          onAuditError: (message) =>
            sinks.debug?.(`audit: ledger append failed: ${message}`),
        })
      : undefined;
  boot.fullAccessWarning = grant?.warning;
  // Audit identity: the base revision this run started from — `git
  // rev-parse HEAD` captured once here, `none` outside git.
  const base = await resolveRunBaseRevision(env.cwd, (cmd, args) =>
    env.shell
      .spawn(cmd, args, {
        provenance: {
          sessionId: id,
          agentId: config.agentId ?? 'root',
          toolCallId: `${request.command}:base-revision`,
          turnId: 0,
          operation: request.command,
        },
      })
      .wait(),
  );
  boot.base = base;
  const role = boot.role?.resolved;
  boot.installed =
    config.policy ??
    installPolicy({
      workspace: env.cwd,
      // The lane enforces the most restrictive merge of the config classes
      // and the role's — a role declaring `network: none` runs under it
      // even when config allows full — and the role's approval
      // obligations challenge on the triggers. No role means the config
      // (or the lane default).
      ...(role === undefined
        ? config.classes === undefined
          ? {}
          : { classes: config.classes }
        : {
            classes: effectiveRoleClasses(
              { ...DEFAULT_PERMISSIONS, ...config.classes },
              role.classes,
            ),
            ...(role.requires.length === 0 ? {} : { requires: role.requires }),
          }),
      // The layer's own record, so the posture's `source` is the same
      // answer doctor prints.
      source: config.policySource ?? 'default',
      ...(config.approvals ?? {}),
      sessionDir: join(root, id),
      // The session root in use is refused control-plane state.
      sessionsRoot: root,
      // Audit identity for the ledger record of each resolved ask, read at
      // record time.
      sessionId: id,
      model: () => boot.liveModelRef,
      thinking: () => boot.liveThinkingRef,
      base,
      // A verified pre-approval file grants what it lists, headless too.
      ...(config.preApprovals === undefined
        ? {}
        : { preApprovals: config.preApprovals }),
      // The answer seat: the user attached to collect verdicts, else the
      // approval broker a run without a terminal asks.
      ...(request.answer !== undefined
        ? { answer: request.answer }
        : config.approvalBroker === undefined
          ? {}
          : {
              answer: webhookApprovalBroker(config.approvalBroker, {
                sessionId: id,
                workspace: env.cwd,
                maxPendingMs:
                  config.approvals?.maxPendingMs ?? DEFAULT_MAX_PENDING_MS,
              }),
            }),
    });
}

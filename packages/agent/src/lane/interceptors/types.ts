// The interceptor options the lane installs, and the approval ask they call.
import type { NetworkLevel, ShellLevel } from '../../permissions.js';

export interface PolicyInterceptorOptions {
  workspace: string;
  shell?: ShellLevel;
  network?: NetworkLevel;
  // Read-only confinement exception: the directories
  // (or files) of the skills advertised with absolute paths outside the
  // workspace. Only the `read` tool may open a path inside one; write,
  // edit, ls, find and grep keep re-rooting every outside path.
  readRoots?: readonly string[];
  isDestructive?: (command: string, workspace: string) => boolean;
  // Approval decider. Consulted for every
  // call first: denials block; approvals let the call
  // through. Only challenged approvals (a real capability was raised and
  // granted) stand down the destructive/network/confine guards for that
  // exact toolCallId — an unchallenged fast-path keeps every guard up.
  // The type lives here (not in host) because the agent cannot import
  // host; the host adapts its ApprovalService to it.
  approve?: (call: ApprovalCall) => Promise<ApprovalAskVerdict>;
}

export interface ApprovalCall {
  toolName: string;
  // The harness-validated arguments, untyped at this seam: the host's
  // detectors own the per-capability shape (same contract as before Pi 1.0).
  args: Record<string, unknown>;
  // The durable call id, which is the provider's toolCallId: the seat's
  // stand-down set is keyed on exactly this value.
  toolCallId: string;
}

export type ApprovalAskVerdict =
  | {
      approved: true;
      challenged: boolean;
      // The operator edited the call before allowing it — these
      // arguments replace the call's (and were judged themselves).
      arguments?: Record<string, unknown>;
    }
  | { approved: false; reason: string };

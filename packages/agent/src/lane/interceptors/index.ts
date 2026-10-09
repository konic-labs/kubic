// Policy interceptors on the lane.
// Registered as ordered pi-durable `ToolTask.beforeTool` hooks,
// so chaining, first-block-wins, and throw-becomes-block are the harness's
// real semantics, not ours. Every handler is fail-closed: a policy exception
// blocks with its redacted message. `beforeTool` runs before the tool's
// intent is committed, so a crash while a handler awaits (the approval seat)
// re-runs the hook on resume instead of resuming an unapproved execution.
//
// Enforcement map (what each class means at this layer):
//   filesystem — tool allowlist + path confine below. Symlinks
//     are NOT resolved (lexical confine only, same limit as the exec seam);
//     a workspace symlink pointing outside is a known escape, documented
//     here instead of silently "handled".
//   shell true — bash present, destructive commands blocked.
//   shell read-only-allowlist — bash present, destructive AND network
//     commands blocked, and every `|`/`&&`/`;`/`&`/newline segment must pass
//     the explicit read-only verb allowlist: redirection,
//     in-place edits, find write actions, write/exec flags, git options that
//     execute code, shell expansion, process substitution and any
//     non-allowlisted verb are refused by name.
//   shell false — bash absent via allowlist.
//   network none (and a domain-less allowlist, enforced as none) —
//   network-command verbs blocked in bash. full
//     change nothing at the tool layer (documented, not silent): there is
//     no network tool to remove, and shell:true can still curl. The flag
//     is consumed by approval triggers.
//   git/credentials — NO tool-layer enforcement today (no git/credential tools
//   exist yet; git arrives with). The flags are stored
//     validated config consumed by approval triggers, never
//     silently dropped.
// The destructive matcher is a literal-pattern heuristic, not a sandbox:
// it sees the command string only, so $CMD indirection, backslash escapes,
// and eval-obfuscation bypass THIS guard (stated, not silent). Since issue
// The trigger layer raises on the cheap shapes this guard misses — a
// destructive/network verb inside $(…)/backticks/eval and `sudo` anywhere
// become approval asks instead of slipping through silently — but the
// detection is still literal-pattern: python/node/npm exfiltration, quoted
// or backslash-obfuscated verbs, and whitespace tricks around redirect
// targets stay unenforceable, documented as such in the host approvals/triggers.ts.

export { confinePath } from './confine.js';
export { defaultIsDestructive, isNetworkCommand } from './detectors.js';
export { policyInterceptorHooks } from './hooks.js';

export { redactReason, redactSecrets } from './redact.js';
export type {
  ApprovalAskVerdict,
  ApprovalCall,
  PolicyInterceptorOptions,
} from './types.js';

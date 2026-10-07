// The composition of request-time key resolution with the §60 ledger (issue
// #359; §36.1 rule 4): every models.json provider-key use appends ONE
// credential-use record — the ref as a sentinel, the role, the purpose —
// to the repo's audit ledger, which `kubic audit` reads. The value never
// enters the record (emitAudit also refuses one carrying a live value).

import {
  appendToLedger,
  auditLedgerDirFor,
  credentialUseAudit,
} from '../policy/audit-ledger.js';
import {
  createModelKeyResolver,
  type ModelKeyResolver,
  withoutIdentity,
} from './secrets.js';

export interface LedgerModelKeyResolverOptions {
  /** The run's workspace; the ledger is the one `kubic audit` reads there. */
  workspace: string;
  role: string;
  sessionId: () => string;
  onError?: (message: string) => void;
  /** The run's provider/model ids: a key that is one of them is identity. */
  identity?: () => readonly string[];
  /**
   * Runs a `!command` secret ref (issue #224): the production runner in
   * the run boots, a fake in tests. Required — a run without one refuses
   * command refs by name instead of leaving them unwired.
   */
  runCommand: (argv: string[]) => string | Promise<string>;
}

export function createLedgerModelKeyResolver(
  options: LedgerModelKeyResolverOptions,
): ModelKeyResolver {
  const dir = auditLedgerDirFor(options.workspace);
  let live: () => string[] = () => [];
  const resolver = createModelKeyResolver({
    role: options.role,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    runCommand: options.runCommand,
    audit: (event) => {
      appendToLedger(
        dir,
        credentialUseAudit({
          sessionId: options.sessionId(),
          role: event.role,
          provider: event.provider,
          ref: event.ref,
          purpose: event.purpose,
          workspace: options.workspace,
          when: event.at,
        }),
        options.onError,
        // The row names its provider: a dummy key equal to that name (LM
        // Studio's `lm-studio`) is not material the row can leak.
        withoutIdentity(live(), [event.provider]),
      );
    },
  });
  live = resolver.live;
  return resolver;
}

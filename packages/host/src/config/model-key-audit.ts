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
  mode?: 'solo' | 'orchestrator';
  onError?: (message: string) => void;
  /** The run's provider/model ids: a key that is one of them is identity. */
  identity?: () => readonly string[];
}

export function createLedgerModelKeyResolver(
  options: LedgerModelKeyResolverOptions,
): ModelKeyResolver {
  const dir = auditLedgerDirFor(options.workspace);
  let live: () => string[] = () => [];
  const resolver = createModelKeyResolver({
    role: options.role,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
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
          ...(options.mode === undefined ? {} : { mode: options.mode }),
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

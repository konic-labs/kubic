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
import { createModelKeyResolver, type ModelKeyResolver } from './secrets.js';

export interface LedgerModelKeyResolverOptions {
  /** The run's workspace; the ledger is the one `kubic audit` reads there. */
  workspace: string;
  role: string;
  sessionId: () => string;
  mode?: 'solo' | 'orchestrator';
  onError?: (message: string) => void;
}

export function createLedgerModelKeyResolver(
  options: LedgerModelKeyResolverOptions,
): ModelKeyResolver {
  const dir = auditLedgerDirFor(options.workspace);
  let live: () => string[] = () => [];
  const resolver = createModelKeyResolver({
    role: options.role,
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
        live(),
      );
    },
  });
  live = resolver.live;
  return resolver;
}

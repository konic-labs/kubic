// The boot's egress step: under `[policy] network_policy = "proxy"` with
// `allowed_domains`, the egress proxy starts for this run and the bash
// tool's environment points at it; every connection through it is a
// `network:egress` audit row. The proxy closes with the boot. A proxy that
// cannot start refuses the boot: the organization mandated it.

import type { ExecutionEnv } from '@kubic/exec/env';
import { configuredEnv } from '@kubic/exec/env';
import {
  appendToLedger,
  auditLedgerDirFor,
  egressAudit,
} from '@kubic/host/audit';
import { startEgressProxy } from '@kubic/host/net';
import type { BootRefusal, SessionBoot } from './bootstrap.js';

export async function bootEgressProxy(
  boot: SessionBoot,
  env: ExecutionEnv,
): Promise<ExecutionEnv | BootRefusal> {
  const network = boot.config.modelPolicy?.network;
  const domains = network?.domains ?? [];
  if (network?.mode !== 'allowlist' || domains.length === 0) return env;
  try {
    boot.egressProxy = await startEgressProxy({
      allowed: domains,
      onConnection: (connection) =>
        appendToLedger(
          auditLedgerDirFor(env.cwd),
          egressAudit({
            sessionId: boot.id,
            workspace: env.cwd,
            ...connection,
          }),
          (message) =>
            boot.sinks.debug?.(`audit: ledger append failed: ${message}`),
        ),
    });
  } catch (error) {
    return {
      kind: 'failed',
      message: `egress proxy: it could not start, and [policy] network_policy = "proxy" requires it: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const url = boot.egressProxy.url;
  return configuredEnv(env, {
    toolEnv: {
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      ALL_PROXY: url,
      https_proxy: url,
      http_proxy: url,
      all_proxy: url,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    },
  });
}

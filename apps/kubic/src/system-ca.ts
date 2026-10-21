// `[tls] systemCa = true` (or KUBIC_SYSTEM_CA=1): trust the operating
// system's certificate store for the rest of this process, before any
// provider, broker or collector request goes out.

import { trustSystemCertificates } from '@kubic/host/net';
import type { CliConfigResult } from './config/load.js';

export function applySystemCertificates(
  cliConfig: CliConfigResult,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
  trust: typeof trustSystemCertificates = trustSystemCertificates,
): void {
  const wanted =
    cliConfig.runtime?.config.tls?.systemCa === true ||
    env.KUBIC_SYSTEM_CA === '1';
  if (!wanted) return;
  const result = trust();
  if ('unsupported' in result) warn(`warning: tls: ${result.unsupported}`);
}

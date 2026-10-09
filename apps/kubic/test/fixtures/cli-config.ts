// The effective config of a run, loaded from the given TOML layers over a
// fixed enterprise path.
import { loadRuntimeConfig, NO_PROJECT_TRUST } from '@kubic/host/config';
import type { CliConfigResult } from '../../src/config/load.js';

export const ENTERPRISE = '/etc/kubic-test/enterprise.toml';

export function cliConfig(
  files: Record<string, string>,
  options: {
    env?: Record<string, string>;
    cliModel?: { provider: string; id: string };
    // Role documents resolve under project trust — tests that
    // load workspace role docs opt into the trusted report.
    trust?: CliConfigResult['trust'];
  } = {},
): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (path: string): boolean => path in files,
      readTextFile: (path: string): string => files[path] as string,
    },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: ENTERPRISE,
    productPath: '/nonexistent/product.toml',
    projectTrusted: true,
    env: options.env ?? {},
    ...(options.cliModel === undefined
      ? {}
      : { cli: { model: options.cliModel } }),
  });
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: options.trust ?? NO_PROJECT_TRUST,
  };
}

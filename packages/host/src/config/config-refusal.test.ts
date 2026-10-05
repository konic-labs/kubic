// Fail-closed on the config-consuming commands (issue #90, criterion 3;
// issue #242): a refused config must stop `kubic run` / `orchestrate` /
// `tui` / `replay` / `clean` / `policy` / `eval` / `benchmark`, not fall
// back to defaults. Proceeding on defaults while the user believes their
// `.kubic/config.toml` is in force is silently ignoring the config — the
// defect this issue exists to fix.
//
// Commands that do not consume config projections stay unaffected, and the
// commands whose job is to REPORT a refusal (`config`, `doctor`, `trust`)
// must still run so the operator can see the named reason.
import { describe, expect, it } from 'vitest';
import type { CliConfigResult } from '../../../../apps/kubic/src/config-runtime.js';
import {
  configRefusalExit,
  requireRuntimeConfig,
} from '../../../../apps/kubic/src/config-runtime.js';
import { NO_PROJECT_TRUST } from './trust-store.js';

function refused(reason: string): CliConfigResult {
  return {
    runtime: undefined,
    error: reason,
    ignoreSplit: { missing: [], checked: [], applicable: true },
    trust: NO_PROJECT_TRUST,
  };
}

function loaded(): CliConfigResult {
  return {
    runtime: {} as CliConfigResult['runtime'],
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: true },
    trust: NO_PROJECT_TRUST,
  };
}

describe('a refused config fails closed on the agent-executing modes', () => {
  it.each([
    'run',
    'orchestrate',
    'tui',
    'attach',
    'resume',
    'clean',
    'policy',
    'eval',
    'benchmark',
  ])(
    'stops `kubic %s` (issue #242: clean/policy consume config too)',
    (command) => {
      const exit = configRefusalExit(
        refused("layer 'project': unknown section '[bogus]'"),
        command,
      );
      expect(exit).toBe(1);
    },
  );

  // The stopped modes print `result.error` (pinned in dispatch.test.ts); the
  // reporting commands surface it through requireRuntimeConfig, which must
  // throw the named reason instead of handing back defaults.
  it('names the refusal so the operator can fix the key', () => {
    expect(() =>
      requireRuntimeConfig(
        refused("layer 'project': unknown section '[bogus]'"),
      ),
    ).toThrow("layer 'project': unknown section '[bogus]'");
  });

  it.each(['config', 'doctor'])('lets `kubic %s` report it', (command) => {
    expect(configRefusalExit(refused('bad key'), command)).toBeUndefined();
  });

  it.each(['git', 'diff', 'journal'])(
    'leaves `kubic %s` alone: it consumes no config projection',
    (command) => {
      expect(configRefusalExit(refused('bad key'), command)).toBeUndefined();
    },
  );

  it('leaves `kubic sessions` alone: its one projection (the retention window) is optional', () => {
    expect(configRefusalExit(refused('bad key'), 'sessions')).toBeUndefined();
  });

  it('stops `kubic replay`: re-execution tiers consume the effective config', () => {
    const exit = configRefusalExit(
      refused("layer 'project': unknown section '[bogus]'"),
      'replay',
    );
    expect(exit).toBe(1);
  });

  it('does not interfere when the config loaded', () => {
    expect(configRefusalExit(loaded(), 'run')).toBeUndefined();
  });

  it('treats a missing command as usage, never as consent to run', () => {
    expect(configRefusalExit(refused('bad key'), undefined)).toBeUndefined();
  });
});

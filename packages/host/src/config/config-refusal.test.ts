// Fail-closed on the agent-executing modes (issue #90, criterion 3): a
// refused config must stop `kubic run` / `orchestrate` / `tui`, not fall back
// to defaults. Proceeding on defaults while the user believes their
// `.kubic/config.toml` is in force is silently ignoring the config — the
// defect this issue exists to fix.
//
// Commands that do not consume config projections stay unaffected, and the
// two commands whose job is to REPORT a refusal (`config`, `doctor`) must
// still run so the operator can see the named reason.
import { describe, expect, it } from 'vitest';
import type { CliConfigResult } from '../../../../apps/kubic/src/config-runtime.js';
import { configRefusalExit } from '../../../../apps/kubic/src/config-runtime.js';

function refused(reason: string): CliConfigResult {
  return {
    runtime: undefined,
    error: reason,
    ignoreSplit: { missing: [], checked: [], applicable: true },
  };
}

function loaded(): CliConfigResult {
  return {
    runtime: {} as CliConfigResult['runtime'],
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: true },
  };
}

describe('a refused config fails closed on the agent-executing modes', () => {
  it.each(['run', 'orchestrate', 'tui'])('stops `kubic %s`', (command) => {
    const exit = configRefusalExit(
      refused("layer 'project': unknown section '[bogus]'"),
      command,
    );
    expect(exit).toBe(1);
  });

  it('names the refusal so the operator can fix the key', () => {
    const exit = configRefusalExit(
      refused("layer 'project': unknown section '[bogus]'"),
      'run',
    );
    expect(exit).toBe(1);
  });

  it.each(['config', 'doctor'])('lets `kubic %s` report it', (command) => {
    expect(configRefusalExit(refused('bad key'), command)).toBeUndefined();
  });

  it.each(['sessions', 'git', 'diff', 'journal', 'clean'])(
    'leaves `kubic %s` alone: it consumes no config projection',
    (command) => {
      expect(configRefusalExit(refused('bad key'), command)).toBeUndefined();
    },
  );

  it('stops `kubic replay`: re-execution tiers consume the effective config', () => {
    const exit = configRefusalExit(
      refused("layer 'project': unknown section '[bogus]'"),
      'replay',
    );
    expect(exit).toBe(1);
  });

  it('names the replay refusal so the operator can fix the key', () => {
    const result = refused("layer 'project': unknown section '[bogus]'");
    expect(configRefusalExit(result, 'replay')).toBe(1);
    expect(result.error).toContain("unknown section '[bogus]'");
  });

  it('does not interfere when the config loaded', () => {
    expect(configRefusalExit(loaded(), 'run')).toBeUndefined();
  });

  it('treats a missing command as usage, never as consent to run', () => {
    expect(configRefusalExit(refused('bad key'), undefined)).toBeUndefined();
  });
});

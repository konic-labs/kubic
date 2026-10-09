// The per-invocation tool selection
// (`--tools`/`--no-tools`) is validated before any lane boots. A selection
// that contradicts the permission classes is refused with the reason
// as the usage terminus (exit 2); unknown names are refused by name; the
// mutual exclusion is a usage error. The lane-level narrowing itself is
// pinned in packages/agent/src/lane/tools-line.test.ts.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { mapTerminusToExitCode } from '@kubic/host/run';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './run/command.js';
import { bootTuiLane } from './tui/boot.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-tools-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const READ_ONLY = {
  ...DEFAULT_PERMISSIONS,
  filesystem: 'read' as const,
  shell: false as const,
  git: false as const,
};

function deps() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('done')]);
  return {
    sessionsRoot: tmpRoot(),
    models,
    env: new FakeExecutionEnv({}),
  };
}

describe('kubic run tool selection', () => {
  it('refuses --tools write under filesystem=read with the reason (exit 2)', async () => {
    const result = await runHeadlessPrompt(
      'do it',
      { tools: ['write'] },
      { ...deps(), policyClasses: READ_ONLY },
    );
    expect(result.terminus).toBe('usage');
    expect(mapTerminusToExitCode(result.terminus)).toBe(2);
    expect(result.error?.message).toBe(
      "filesystem is 'read' but write tool 'write' is registered",
    );
    // Refused before any store existed.
    expect(result.sessionId).toBe('unassigned');
  });

  it('refuses an unknown tool by name', async () => {
    const result = await runHeadlessPrompt(
      'do it',
      { tools: ['read', 'nope'] },
      deps(),
    );
    expect(result.terminus).toBe('usage');
    expect(result.error?.message).toContain('unknown tool "nope"');
    expect(result.error?.message).toContain('known tools:');
  });

  it('refuses --tools together with --no-tools for a library caller', async () => {
    const result = await runHeadlessPrompt(
      'do it',
      { tools: ['read'], noTools: true },
      deps(),
    );
    expect(result.terminus).toBe('usage');
    expect(result.error?.message).toContain('mutually exclusive');
  });

  it('runs a narrowed selection and a chat-only --no-tools run to completion', async () => {
    const narrowed = await runHeadlessPrompt(
      'do it',
      { tools: ['read', 'ls'] },
      deps(),
    );
    expect(narrowed.terminus).toBe('completed');
    expect(narrowed.summary).toBe('done');
    const chatOnly = await runHeadlessPrompt(
      'do it',
      { noTools: true },
      deps(),
    );
    expect(chatOnly.terminus).toBe('completed');
  });
});

describe('kubic tui tool selection', () => {
  it('refuses a class-contradicting selection before any session exists', async () => {
    const root = tmpRoot();
    await expect(
      bootTuiLane(undefined, {
        sessionsRoot: root,
        classes: READ_ONLY,
        toolSelection: ['write'],
      }),
    ).rejects.toThrow(
      /filesystem is 'read' but write tool 'write' is registered/,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses an unknown tool by name', async () => {
    await expect(
      bootTuiLane(undefined, {
        sessionsRoot: tmpRoot(),
        toolSelection: ['nope'],
      }),
    ).rejects.toThrow(/unknown tool "nope"/);
  });
});

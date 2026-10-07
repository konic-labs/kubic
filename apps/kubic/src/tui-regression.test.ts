// `kubic tui` host-side regression (issue #75).
// The tui entry lives in apps/kubic (the composition root: the only
// owner allowed to wire host + tui together), so the cross-cutting
// proof lives here next to run-prod-path.test.ts. This file never
// imports @kubic/tui (dep-lint): the fake terminal satisfies the seam
// structurally. Faux lane boot only — zero network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { runRunCommand } from '../../../packages/host/src/run-cli.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runHeadlessPrompt } from './headless-run.js';
import { runTuiCommand } from './tui-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-regression-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  // The solo notice is not under test here (solo-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function fakeTerminal(width: number) {
  return terminalRig(width, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

describe('tui entry regression (issue #75)', () => {
  it('routes input and restores the main screen on quit', async () => {
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId?: string) => ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
        }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
    expect(lines.join('\n')).toContain('session s1');
  });

  it('headless `kubic run` mounts no screen beside the tui entry', async () => {
    const lines: string[] = [];
    const code = await runRunCommand(
      { prompt: 'hi' },
      {
        out: (line: string) => lines.push(line),
        run: async () => ({
          terminus: 'completed' as const,
          summary: 'hi',
          sessionId: 's',
          journalRef: 'journal:s',
          usageRef: 'usage:s',
          trajectoryRef: 'trajectory:s',
        }),
        onScreenMount: () => {
          throw new Error('alt-screen mounted on the headless path');
        },
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('result: hi');
    // The hook is inert on this path (run-cli never calls it), so the
    // observable half is the output: no alt-screen sequence reaches it.
    expect(lines.join('\n')).not.toContain('?1049h');
  });

  it('headless `kubic run` exit codes and transcript are unchanged by the loop (issue #88)', async () => {
    // Criterion 6: the prompt loop must not alter the headless path. A real
    // lane run through the same composition root (apps/kubic) with faux
    // models, driving the same `runHeadlessPrompt` the loop shares the lane
    // boot with. NOTE: run-cli's `onScreenMount` hook is never invoked
    // (`void deps.onScreenMount`), so the alt-screen invariant is asserted on
    // the emitted output — the only thing a user could actually observe.
    const root = tmpRoot();
    const lines: string[] = [];
    const code = await runRunCommand(
      { prompt: 'headless hi' },
      {
        out: (line: string) => lines.push(line),
        run: (prompt: string) =>
          runHeadlessPrompt(
            prompt,
            {},
            {
              sessionsRoot: root,
              models: fauxModels(['headless answer']),
              env: new FakeExecutionEnv({}),
            },
          ),
      },
    );
    expect(code).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('result: headless answer');
    expect(doc).toContain('usage: usage:');
    expect(doc).toContain('journal: journal:');
    // Issue #383: the ref is the written §46 file's path.
    expect(doc).toMatch(/trajectory: \S+\/trajectory\.json/);
    // No alt-screen escape sequences ever reach the headless output.
    expect(doc).not.toContain('?1049h');
    expect(doc).not.toContain('?1049l');
  });

  it('headless run keeps each terminus on its §78 exit code (issue #88)', async () => {
    const cases: Array<[string, number]> = [
      ['completed', 0],
      ['failed', 1],
      ['usage', 2],
      ['turn_limit', 3],
      ['approval_timed_out', 4],
      ['workspace_unavailable', 5],
      ['provider_probe_failed', 6],
    ];
    for (const [terminus, expected] of cases) {
      const lines: string[] = [];
      const code = await runRunCommand(
        { prompt: 'x' },
        {
          out: (line: string) => lines.push(line),
          run: async () => ({
            terminus: terminus as never,
            summary: 's',
            sessionId: 's',
            journalRef: 'journal:s',
            usageRef: 'usage:s',
            trajectoryRef: 'trajectory:s',
            ...(terminus === 'failed'
              ? { error: { kind: 'failed' as const, message: 's' } }
              : {}),
          }),
        },
      );
      expect([terminus, code]).toEqual([terminus, expected]);
    }
  });
});

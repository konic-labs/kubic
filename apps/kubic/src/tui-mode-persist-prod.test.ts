// Issue #276 (§9.2, §17): the session mode toggle is session-scoped and
// persisted — Ctrl-G to orchestrator survives a reattach, and a fresh session
// still starts solo (config default absent). Faux provider; the real boot
// path with the git probe stubbed to a repository; temp dirs cleaned up.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { bootTuiLane, runTuiCommand, type TuiRunDeps } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('persisted session mode (issue #276)', () => {
  it('Ctrl-G to orchestrator survives a reattach; a fresh session starts solo', {
    timeout: 30000,
  }, async () => {
    const sessionsRoot = tmpRoot('tui-276-sessions-');
    const workspace = tmpRoot('tui-276-ws-');
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('unused')]);
    models.setProvider(faux.provider);
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
    const open = (session?: string) => {
      const fake = terminalRig(140, 30);
      const lines: string[] = [];
      const exit = runTuiCommand(session === undefined ? {} : { session }, {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane,
        isGitRepo: () => true,
      });
      return { fake, lines, exit };
    };

    const first = open();
    await waitFor(() => first.fake.counts.started === 1);
    first.fake.feed('\x07');
    await waitFor(() => first.fake.frame.includes('orchestrator'));
    first.fake.feed('\x04');
    expect(await first.exit).toBe(0);
    const [id] = readdirSync(sessionsRoot).filter((e) => !e.startsWith('.'));
    expect(
      JSON.parse(
        readFileSync(join(sessionsRoot, id as string, 'mode.json'), 'utf8'),
      ),
    ).toMatchObject({ on: true, scope: 'session' });

    // Reattach: the status bar starts in orchestrator mode.
    const again = open(id);
    await waitFor(() => again.fake.counts.started === 1);
    again.fake.feed('\x04');
    expect(await again.exit).toBe(0);
    expect(again.lines.join('\n')).toContain('orchestrator');

    // A fresh session (no saved toggle, no config default) starts solo.
    const fresh = open();
    await waitFor(() => fresh.fake.counts.started === 1);
    fresh.fake.feed('\x04');
    expect(await fresh.exit).toBe(0);
    expect(fresh.lines.join('\n')).not.toContain('orchestrator');
  });
});

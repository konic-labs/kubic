// `kubic tui --session <id>` seeds the prompt editor's
// history from the resumed session's committed user prompts, so Up recalls
// what the previous process sent. Faux provider; the real boot path.
import { readdirSync } from 'node:fs';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { describe, expect, it } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tempDir } from '../../../../test/temp-dir.js';
import { bootTuiLane } from '../../src/tui/boot.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('resumed prompt history', () => {
  it('Up recalls the last prompt from the previous process', {
    timeout: 20000,
  }, async () => {
    const workspace = tempDir('tui-history-resume-ws-');
    const sessionsRoot = tempDir('tui-history-resume-sessions-');
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('noted')]);
    models.setProvider(faux.provider);
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
    const open = (session?: string) => {
      const fake = terminalRig(120, 30);
      const exit = runTuiCommand(session === undefined ? {} : { session }, {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane,
      });
      return { fake, exit };
    };

    const first = open();
    await waitFor(() => first.fake.counts.started === 1);
    for (const ch of 'remember this prompt') first.fake.feed(ch);
    first.fake.feed('\r');
    await waitFor(() => first.fake.frame.includes('noted'));
    first.fake.feed('\x04');
    expect((await first.exit).exitCode).toBe(0);
    const [sessionId] = readdirSync(sessionsRoot).filter(
      (entry) => !entry.startsWith('.'),
    );
    expect(sessionId).toBeDefined();

    const second = open(sessionId);
    await waitFor(() => second.fake.counts.started === 1);
    await waitFor(() => second.fake.frame.includes('noted'));
    const mark = second.fake.mark();
    second.fake.feed('\x1b[A');
    // Only the editor row changes on Up: the recalled prompt is drawn there
    // (Pi paints the cursor cell in reverse video, so styling is stripped).
    const csi = new RegExp(
      `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
      'g',
    );
    const plain = (text: string): string => text.replace(csi, '');
    await waitFor(() =>
      plain(second.fake.since(mark)).includes('remember this prompt'),
    );
    // The recalled draft takes the first Ctrl-C; the double press quits.
    second.fake.feed('\x03');
    second.fake.feed('\x03');
    second.fake.feed('\x03');
    expect((await second.exit).exitCode).toBe(0);
  });
});

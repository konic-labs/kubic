// A transient model error is retried by the
// harness after a backoff, and that wait is named — on the TUI footer while
// it lasts (cleared once the retry settles) and as a `[lane]` line on
// `kubic run --debug` — instead of looking like a hang. Faux provider only:
// the first response is a transient error, the second succeeds; the backoff
// is pi-durable's own default, so the TUI test observes a real window.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runHeadlessPrompt } from './headless-run.js';
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

function transientThenRecovered() {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: 'server overloaded',
    }),
    fauxAssistantMessage(fauxText('recovered')),
  ]);
  models.setProvider(faux.provider);
  return models;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('retry activity on the kubic tui footer', () => {
  it('names the retry while it waits, then clears it', {
    timeout: 20000,
  }, async () => {
    const workspace = tmpRoot('tui-lane-activity-ws-');
    const sessionsRoot = tmpRoot('tui-lane-activity-sessions-');
    const models = transientThenRecovered();
    const fake = terminalRig(120, 30);
    const printed: string[] = [];
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => printed.push(line),
        createTerminal: () => fake.terminal,
        bootLane,
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'say hi') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.frame.includes('⟳ retrying · attempt 1 — server overloaded'),
    );
    await waitFor(() => fake.frame.includes('recovered'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    // The document printed on quit is the whole layout, editor row included:
    // the retry line is gone once the retry settled.
    const finalDocument = printed.join('\n');
    expect(finalDocument).toContain('recovered');
    expect(finalDocument).not.toContain('retrying');
  });
});

describe('retry activity on kubic run --debug', () => {
  it('writes a [lane] retry line to the debug sink', {
    timeout: 20000,
  }, async () => {
    const debug: string[] = [];
    const result = await runHeadlessPrompt(
      'say hi',
      { debug: true },
      {
        sessionsRoot: tmpRoot('run-lane-activity-sessions-'),
        models: transientThenRecovered(),
        env: new NodeExecutionEnv(tmpRoot('run-lane-activity-ws-')),
        debugSink: (line) => debug.push(line),
        warn: () => undefined,
      },
    );
    expect(result.terminus).toBe('completed');
    expect(debug).toContain(
      '[lane] retry attempt 1 after error: server overloaded',
    );
    expect(debug).toContain('[lane] retry attempt 1 settled');
  });
});

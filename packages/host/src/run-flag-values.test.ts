// Flag values that start with `--` (issue #127): the escape hatches.
// Faux-only prod path: the composition-root runner (apps/kubic) drives a
// real lane with faux models, zero network — the same black-box posture as
// run-prod-path.test.ts. This file pins the three acceptance escapes:
//   --prompt="--help"            equals form, value verbatim
//   -p -- --json-experiment      end-of-flags, next raw token
//   -p --json                    still the typo error (never weakened)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../worker/src/pi-boundary.js';
import { type HeadlessRunResult, runRunCommand } from './run-cli.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-flag-values-'));
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function fauxRun(root: string, reply = 'all done') {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(reply)]);
  return (prompt: string): Promise<HeadlessRunResult> =>
    runHeadlessPrompt(
      prompt,
      {},
      { sessionsRoot: root, models, env: new FakeExecutionEnv({}) },
    );
}

function entryTexts(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const texts: string[] = [];
  for (const entry of entries) {
    const message = (entry as { message?: unknown }).message as {
      content?: unknown;
    };
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const text = (part as { type?: unknown; text?: unknown }).text;
      if (
        (part as { type?: unknown }).type === 'text' &&
        typeof text === 'string'
      )
        texts.push(text);
    }
  }
  return texts;
}

async function transcriptOf(root: string, sessionId: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
    return entryTexts(entries).join('\n');
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

describe('run flag values starting with -- (issue #127)', () => {
  it('boots a lane whose prompt is literally --help via the equals form', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = await runRunCommand(['--prompt=--help'], {
      out: o.write,
      run: fauxRun(root),
    });
    expect(exit).toBe(0);
    // A help request would have printed the usage line and exited 0 without
    // running: the lane must have booted instead.
    expect(o.lines.join('\n')).not.toMatch(/usage: kubic run/);
    const sessionId = (o.lines.join('\n').match(/^session: (.+)$/m) ??
      [])[1] as string;
    expect(sessionId).toBeDefined();
    expect(await transcriptOf(root, sessionId)).toContain('--help');
  });

  it('takes the next raw token after -- as the prompt (-p -- --json-experiment)', async () => {
    const root = tmpRoot();
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['-p', '--', '--json-experiment'], {
      out: o.write,
      run: async (prompt: string) => {
        seen.prompt = prompt;
        return fauxRun(root)(prompt);
      },
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('--json-experiment');
    const sessionId = (o.lines.join('\n').match(/^session: (.+)$/m) ??
      [])[1] as string;
    expect(await transcriptOf(root, sessionId)).toContain('--json-experiment');
  });

  it('leaves --json unset when the prompt merely starts with --json', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = await runRunCommand(['-p', '--', '--json-experiment'], {
      out: o.write,
      run: fauxRun(root),
    });
    expect(exit).toBe(0);
    // --json would collapse the whole output into one JSON envelope line.
    expect(o.lines[0]).toMatch(/^result: /);
    expect(o.lines.length).toBeGreaterThan(1);
  });

  it('accepts a --json-prefixed prompt through the equals form too', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = await runRunCommand(['--prompt=--json-experiment'], {
      out: o.write,
      run: fauxRun(root),
    });
    expect(exit).toBe(0);
    expect(o.lines[0]).toMatch(/^result: /);
  });

  it('still catches the typo: -p --json is a missing value, exit 2', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', '--json'], {
      out: o.write,
      run: async () => {
        called = true;
        return fauxRun(tmpRoot())('x');
      },
    });
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/-p needs a value/);
  });

  it('keeps -p without a value (and no --) an error', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', '--'], {
      out: o.write,
      run: async () => fauxRun(tmpRoot())('x'),
    });
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/-p needs a value/);
  });
});

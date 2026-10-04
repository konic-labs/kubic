// Prompt image attachments in `kubic tui` (issue #338; §16.5 Image, §16.8
// Images): `/image <path>` and a terminal-pasted inline image reach the
// lane's user-message content, and a model without image input refuses the
// attachment by name instead of sending it. Faux provider only: zero
// network, zero paid tokens.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { bootTuiLane, runTuiCommand, type TuiLaneBoot } from './tui-run.js';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-images-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// The user message the faux provider last received, structurally typed:
// only `role` and `content` are read, so this test needs no Pi type.
type SeenMessage = { role: string; content: unknown };

// The faux provider's last user message, captured per request.
function captureUserMessage() {
  const seen: SeenMessage[] = [];
  return {
    seen,
    respond: (context: { messages: SeenMessage[] }) => {
      const last = [...context.messages]
        .reverse()
        .find((message) => message.role === 'user');
      if (last !== undefined) seen.push(last);
      return fauxAssistantMessage('seen');
    },
  };
}

function fauxModels(
  models: ReadonlyArray<{ id: string; input?: ('text' | 'image')[] }>,
  respond: (context: {
    messages: SeenMessage[];
  }) => ReturnType<typeof fauxAssistantMessage>,
): MutableModels {
  const faux = fauxProvider({ models: [...models] });
  faux.setResponses([respond]);
  const registry = createModels();
  registry.setProvider(faux.provider);
  return registry;
}

function recordingTerminal() {
  const writes: string[] = [];
  const counts = { started: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    feed: (data: string) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {},
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return 140;
      },
      get rows(): number {
        return 30;
      },
      get kittyProtocolActive(): boolean {
        return false;
      },
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
    } satisfies Terminal,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

interface Session {
  readonly fake: ReturnType<typeof recordingTerminal>;
  readonly exit: Promise<number>;
  readonly boots: TuiLaneBoot[];
}

// One `kubic tui` run over a real faux lane whose catalog is `models`.
function startSession(
  root: string,
  models: MutableModels,
  modelId: string,
): Session {
  const fake = recordingTerminal();
  const boots: TuiLaneBoot[] = [];
  const exit = runTuiCommand(
    {},
    {
      out: () => {},
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      bootLane: async (sessionId) => {
        const boot = await bootTuiLane(sessionId, {
          sessionsRoot: root,
          models,
          env: new FakeExecutionEnv({}),
          model: { provider: 'faux', id: modelId },
        });
        boots.push(boot);
        return boot;
      },
    },
  );
  return { fake, exit, boots };
}

describe('kubic tui /image (issue #338)', () => {
  it('carries the attached image into the prompt the lane sends', async () => {
    const root = tmpRoot();
    const shot = join(root, 'screenshot.png');
    writeFileSync(shot, PNG);
    const capture = captureUserMessage();
    const { fake, exit } = startSession(
      root,
      fauxModels([{ id: 'vision', input: ['text', 'image'] }], capture.respond),
      'vision',
    );
    await waitFor(() => fake.counts.started === 1);

    for (const ch of `/image ${shot}`) fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('image attached'));

    for (const ch of 'describe it') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('seen'));

    expect(capture.seen).toHaveLength(1);
    expect(capture.seen[0]?.content).toEqual([
      { type: 'text', text: 'describe it' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it('attaches an image the terminal pastes inline (iTerm2 OSC 1337)', async () => {
    const root = tmpRoot();
    const capture = captureUserMessage();
    const { fake, exit } = startSession(
      root,
      fauxModels([{ id: 'vision', input: ['text', 'image'] }], capture.respond),
      'vision',
    );
    await waitFor(() => fake.counts.started === 1);

    const name = Buffer.from('shot.png', 'latin1').toString('base64');
    fake.feed(
      `\x1b]1337;File=name=${name};size=${PNG.byteLength};inline=1:${PNG.toString('base64')}\x07`,
    );
    await waitFor(() => fake.writes.join('').includes('image attached'));

    for (const ch of 'what is this') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('seen'));

    expect(capture.seen[0]?.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it('refuses the attachment when the model takes no image input', async () => {
    const root = tmpRoot();
    const shot = join(root, 'screenshot.png');
    writeFileSync(shot, PNG);
    const capture = captureUserMessage();
    const { fake, exit } = startSession(
      root,
      // Text-only modalities, as `models.json` defaults them (§37.2).
      fauxModels([{ id: 'plain', input: ['text'] }], capture.respond),
      'plain',
    );
    await waitFor(() => fake.counts.started === 1);

    for (const ch of `/image ${shot}`) fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes.join('').includes('does not accept image input'),
    );

    for (const ch of 'hello') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('seen'));
    // Nothing was attached: the prompt goes as the plain string it always was.
    expect(capture.seen[0]?.content).toBe('hello');

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it('refuses a file that is not an image, by name', async () => {
    const root = tmpRoot();
    const notes = join(root, 'notes.txt');
    writeFileSync(notes, 'not an image');
    const { fake, exit } = startSession(
      root,
      fauxModels([{ id: 'vision', input: ['text', 'image'] }], () =>
        fauxAssistantMessage('seen'),
      ),
      'vision',
    );
    await waitFor(() => fake.counts.started === 1);

    for (const ch of `/image ${notes}`) fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes.join('').includes('is not a supported image'),
    );

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });
});

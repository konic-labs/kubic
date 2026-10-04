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
import {
  bootTuiLane,
  readImageFile,
  runTuiCommand,
  type TuiLaneBoot,
} from './tui-run.js';

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

// One `kubic tui` run over a stub lane: the routing decision (which lane a
// submit reaches) is what these tests observe, so no provider is involved.
function startStubSession(mode: 'solo' | 'orchestrator'): Session & {
  readonly admitted: Array<{ prompt: string; images: number }>;
  readonly objectives: string[];
} {
  const fake = recordingTerminal();
  const admitted: Array<{ prompt: string; images: number }> = [];
  const objectives: string[] = [];
  const loop = {
    runTurn: async (prompt: string, opts?: { images?: readonly unknown[] }) => {
      admitted.push({ prompt, images: opts?.images?.length ?? 0 });
      return { kind: 'completed', submissionId: `sub-${admitted.length}` };
    },
    supportsImages: async () => true,
    subscribe: async () => async () => {},
    entries: async () => [],
    abort: async () => {},
    forgetKills: () => {},
    killsKey: 'conversation',
    kills: { track: () => {}, drain: () => [] },
    context: { signal: new AbortController().signal },
  };
  const drive = {
    run: async (objective: string) => {
      objectives.push(objective);
      return { status: 'completed' as const };
    },
  };
  const exit = runTuiCommand(
    mode === 'orchestrator' ? { orchestrator: true } : {},
    {
      out: () => {},
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      isGitRepo: () => true,
      bootLane: async (sessionId?: string) =>
        ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
          loop,
          orchestrator: drive,
        }) as unknown as TuiLaneBoot,
    },
  );
  return { fake, exit, boots: [], admitted, objectives };
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

  // Issue #338 review: the editor dropped a blank draft before onSubmit, so
  // attach + Enter was a silent no-op while the footer said "Enter sends it".
  it('sends an image-only prompt (Enter on an empty draft)', async () => {
    const root = tmpRoot();
    const shot = join(root, 'shot.png');
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

    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('seen'));

    // No empty text part: the image IS the message.
    expect(capture.seen).toHaveLength(1);
    expect(capture.seen[0]?.content).toEqual([
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  // Issue #338 review: the /model drop and the orchestrator refusal were
  // claimed by the report and the docs but pinned by no test.
  it('drops pending attachments when /model switches to a text-only model', async () => {
    const root = tmpRoot();
    const shot = join(root, 'shot.png');
    writeFileSync(shot, PNG);
    const capture = captureUserMessage();
    const { fake, exit } = startSession(
      root,
      fauxModels(
        [
          { id: 'vision', input: ['text', 'image'] },
          { id: 'textonly', input: ['text'] },
        ],
        capture.respond,
      ),
      'vision',
    );
    await waitFor(() => fake.counts.started === 1);

    for (const ch of `/image ${shot}`) fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('image attached'));

    for (const ch of '/model faux/textonly') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes(
          'dropped 1 attached image — faux/textonly does not accept image input',
        ),
    );

    // The next prompt reaches the text-only model as a bare string: the
    // attachment was dropped, not carried into a request it cannot take.
    for (const ch of 'what now') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('seen'));
    expect(capture.seen[0]?.content).toBe('what now');

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it('keeps pending attachments when the orchestrator lane refuses them', async () => {
    const root = tmpRoot();
    const shot = join(root, 'shot.png');
    writeFileSync(shot, PNG);
    const { fake, exit, admitted, objectives } =
      startStubSession('orchestrator');
    await waitFor(() => fake.counts.started === 1);

    for (const ch of `/image ${shot}`) fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('image attached'));

    for (const ch of 'do it') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes(
          'image attachments need the solo lane — switch back with ctrl+g',
        ),
    );
    expect(objectives).toEqual([]);
    expect(admitted).toEqual([]);

    // Ctrl-G back to solo, then Enter: the draft the refusal handed back
    // rides with the KEPT attachment — the refusal was "not here", not
    // "dropped".
    fake.feed('\x07');
    fake.feed('\r');
    await waitFor(() => admitted.length === 1);
    expect(admitted).toEqual([{ prompt: 'do it', images: 1 }]);

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  // Issue #338 review: `readFileRange` → `openSync` blocks the event loop
  // forever on a FIFO with no writer (and on device nodes), so the
  // regular-file check must come first — no Ctrl-C could ever run.
  it('refuses a non-regular file without opening it', () => {
    const bridge = {
      absolutePath: (path: string) => path,
      fileInfo: () => ({
        name: 'fifo',
        path: '/tmp/fifo',
        isDirectory: false,
        isSymbolicLink: false,
        isFile: false,
        size: 0,
        mtimeMs: 0,
      }),
      readFileRange: () => {
        throw new Error('a FIFO must never be read');
      },
    } as unknown as Parameters<typeof readImageFile>[0];
    expect(readImageFile(bridge, '/tmp/fifo')).toEqual({
      ok: false,
      message: "'fifo' is not a regular file",
    });
  });

  // Issue #338 review: the payload used to be decoded before the size check,
  // so an oversize paste allocated a second, larger buffer first.
  it('refuses an oversize inline paste without decoding it', async () => {
    const { fake, exit } = startStubSession('solo');
    await waitFor(() => fake.counts.started === 1);

    fake.feed(
      `\x1b]1337;File=name=big.png;inline=1:${'A'.repeat(7 * 1024 * 1024)}\x07`,
    );
    await waitFor(() =>
      fake.writes.join('').includes('is too large (> 5.0 MB)'),
    );
    // The garbage never reached the draft.
    expect(fake.writes.join('')).not.toContain('AAAAAAAA');

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  // An unterminated sequence past the reassembly cap is dropped by the
  // scanner — no payload is ever held — and the operator is still told why.
  it('drops an unterminated oversize paste instead of buffering it', async () => {
    const { fake, exit } = startStubSession('solo');
    await waitFor(() => fake.counts.started === 1);

    fake.feed(
      `\x1b]1337;File=name=big.png;inline=1:${'A'.repeat(7 * 1024 * 1024)}`,
    );
    await waitFor(() =>
      fake.writes.join('').includes('is too large (> 5.0 MB)'),
    );
    expect(fake.writes.join('')).not.toContain('AAAAAAAA');

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  // Issue #338 review: a >4 KB paste arrives in chunks (the pty splits it and
  // pi-tui's StdinBuffer flushes a partial OSC after 50 ms), so the sequence
  // is reassembled across listener calls instead of typed into the draft.
  it('reassembles an inline paste split across two input calls', async () => {
    const root = tmpRoot();
    const capture = captureUserMessage();
    const { fake, exit } = startSession(
      root,
      fauxModels([{ id: 'vision', input: ['text', 'image'] }], capture.respond),
      'vision',
    );
    await waitFor(() => fake.counts.started === 1);

    const name = Buffer.from('big.png', 'latin1').toString('base64');
    const sequence = `\x1b]1337;File=name=${name};inline=1:${PNG.toString('base64')}\x07`;
    fake.feed(sequence.slice(0, 30));
    fake.feed(sequence.slice(30));
    await waitFor(() => fake.writes.join('').includes('image attached'));
    expect(fake.writes.join('')).not.toContain('1337;File=');

    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('seen'));
    expect(capture.seen[0]?.content).toEqual([
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);

    fake.feed('\x03');
    expect(await exit).toBe(0);
  });
});

// Prompt image attachments in `kubic tui` (Image, Images): `/image <path>` and
// a terminal-pasted inline image reach the lane's user-message content, and a
// model without image input refuses the attachment by name instead of sending
// it. Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import type { CommandResult } from '../../../packages/core/src/cli/exit-codes.js';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import {
  bootTuiLane,
  PASTE_IDLE_MS,
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
  // A faked clock must never outlive a test: `waitFor` polls with real
  // timers, so a leaked fake clock would hang every later wait.
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// The paste state machine arms its idle valve with `setTimeout`. Feeding the
// chunks of one paste inside this window means no real time can pass between
// them — a loaded machine can stall a task for longer than PASTE_IDLE_MS, and
// the valve firing mid-paste is a test-timing failure that blames the
// product. `waitFor` needs real timers, so the
// window is always closed again before waiting.
function withFrozenTime<T>(body: () => T): T {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    return body();
  } finally {
    vi.useRealTimers();
  }
}

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
  return terminalRig(140, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

interface Session {
  readonly fake: ReturnType<typeof recordingTerminal>;
  readonly exit: Promise<CommandResult>;
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
function startStubSession(
  // `hold: true` keeps the first turn in flight until `release()` is called,
  // so a test can act while the lane is busy (the echo still holds its
  // images). The default settles immediately.
  options: { readonly hold?: boolean } = {},
): Session & {
  readonly admitted: Array<{ prompt: string; images: number }>;
  readonly release: () => void;
} {
  const fake = recordingTerminal();
  const admitted: Array<{ prompt: string; images: number }> = [];
  let releaseTurn: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const loop = {
    runTurn: async (prompt: string, opts?: { images?: readonly unknown[] }) => {
      admitted.push({ prompt, images: opts?.images?.length ?? 0 });
      if (options.hold === true) await held;
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
  const exit = runTuiCommand(
    {},
    {
      out: () => {},
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      bootLane: async (sessionId?: string) =>
        ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
          loop,
        }) as unknown as TuiLaneBoot,
    },
  );
  return {
    fake,
    exit,
    boots: [],
    admitted,
    release: () => releaseTurn?.(),
  };
}

describe('kubic tui /image', () => {
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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  it('refuses the attachment when the model takes no image input', async () => {
    const root = tmpRoot();
    const shot = join(root, 'screenshot.png');
    writeFileSync(shot, PNG);
    const capture = captureUserMessage();
    const { fake, exit } = startSession(
      root,
      // Text-only modalities, as `models.json` defaults them.
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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // The editor dropped a blank draft before onSubmit, so
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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // `allowEmptySubmit` must read the UNSUBMITTED
  // attachments. The echo keeps the sent images until the lane's own prompt
  // cell lands, so a blank Enter while the turn runs (a double-tap, or habit)
  // must stay a no-op instead of queueing a prompt with no images.
  it('does not submit a blank prompt between a submit and its echo', async () => {
    const root = tmpRoot();
    const shot = join(root, 'shot.png');
    writeFileSync(shot, PNG);
    const { fake, exit, admitted, release } = startStubSession({
      hold: true,
    });
    await waitFor(() => fake.counts.started === 1);

    for (const ch of `/image ${shot}`) fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('image attached'));

    for (const ch of 'solo it') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => admitted.length === 1);
    expect(admitted).toEqual([{ prompt: 'solo it', images: 1 }]);

    // The turn is still running and the echo still shows the image; a blank
    // Enter must not queue a second, imageless prompt.
    fake.feed('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(admitted).toHaveLength(1);

    release();
    // The settled turn must not resurrect the blank submit either.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(admitted).toHaveLength(1);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // `readFileRange` → `openSync` blocks the event loop
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

  // The size check runs before the payload is decoded, so an oversize paste
  // never allocates a second, larger buffer first.
  it('refuses an oversize inline paste without decoding it', async () => {
    const { fake, exit } = startStubSession();
    await waitFor(() => fake.counts.started === 1);

    fake.feed(
      `\x1b]1337;File=name=big.png;inline=1:${'A'.repeat(7 * 1024 * 1024)}\x07`,
    );
    await waitFor(() =>
      fake.writes.join('').includes('is too large (> 5.0 MB)'),
    );
    // The garbage never reached the draft.
    expect(fake.writes.join('')).not.toContain('AAAAAAAA');

    // The typed draft takes the first Ctrl-C; the double press quits.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // An unterminated sequence past the reassembly cap is dropped by the
  // scanner — no payload is ever held — and the operator is still told why.
  it('drops an unterminated oversize paste instead of buffering it', async () => {
    const { fake, exit } = startStubSession();
    await waitFor(() => fake.counts.started === 1);

    // Three calls, like a real pty. The second pushes the held sequence past
    // the reassembly cap, and the third is pure payload: the discard state
    // must consume it up to the terminator rather than type megabytes of
    // base64 into the draft.
    // All three chunks back to back, with no await between them: the second
    // feed sets the footer synchronously, so nothing here depends on the
    // idle valve not firing first (a >PASTE_IDLE_MS stall between feeds on a
    // loaded machine would otherwise clear the discard state and type the
    // third chunk's payload — a test-timing failure that blames the product).
    const payload = 'A'.repeat(7 * 1024 * 1024);
    withFrozenTime(() => {
      fake.feed(
        `\x1b]1337;File=name=big.png;inline=1:${payload.slice(0, 4096)}`,
      );
      fake.feed(payload.slice(4096, 7 * 1024 * 1024 - 2048));
      fake.feed(`${payload.slice(-2048)}\x07`);
    });
    await waitFor(() =>
      fake.writes.join('').includes('is too large (> 5.0 MB)'),
    );
    // Then type normally: the draft must hold only what was typed after the
    // paste, never payload.
    for (const ch of 'after') fake.feed(ch);
    await waitFor(() => fake.writes.join('').includes('after'));
    expect(fake.writes.join('')).not.toContain('AAAAAAAA');

    // The typed draft takes the first Ctrl-C; the double press quits.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // An unterminated sequence that never completes
  // must not swallow the operator's typing for the rest of the session.
  it('drops an unterminated sequence after a short idle window', async () => {
    const { fake, exit } = startStubSession();
    await waitFor(() => fake.counts.started === 1);

    fake.feed('\x1b]1337;File=name=x;inline=1:AAAA');
    await waitFor(() =>
      fake.writes.join('').includes('pasted image incomplete — ignored'),
    );
    for (const ch of 'typed') fake.feed(ch);
    await waitFor(() => fake.writes.join('').includes('typed'));
    expect(fake.writes.join('')).not.toContain('AAAA');

    // The typed draft takes the first Ctrl-C; the double press quits.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // The discard state needs the same valve as the
  // pending one — a paste whose terminator never arrives (the pty truncation
  // that gets you into this state) would otherwise swallow every later
  // keystroke, Ctrl-C included, until stdin closed.
  it('gives input back when an oversize paste never terminates', async () => {
    const { fake, exit } = startStubSession();
    await waitFor(() => fake.counts.started === 1);

    // One call: the sequence is already past the cap when it arrives, so no
    // earlier partial buffer exists to inherit a timer from — the discard
    // state arms its own valve, on the faked clock, and the advance fires it.
    // The footer deliberately stays the same when the valve fires (the paste
    // really was over the cap), so typing again is the observable.
    withFrozenTime(() => {
      fake.feed(
        `\x1b]1337;File=name=big.png;inline=1:${'A'.repeat(7 * 1024 * 1024)}`,
      );
      expect(fake.writes.join('')).toContain('is too large (> 5.0 MB)');
      vi.advanceTimersByTime(PASTE_IDLE_MS + 1);
    });
    for (const ch of 'typed') fake.feed(ch);
    await waitFor(() => fake.writes.join('').includes('typed'));
    expect(fake.writes.join('')).not.toContain('AAAAAAAA');

    // The typed draft takes the first Ctrl-C; the double press quits.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });

  // A >4 KB paste arrives in chunks (the pty splits it and
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
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
  });
});

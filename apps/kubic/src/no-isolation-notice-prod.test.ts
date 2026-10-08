// Solo no-isolation notice on the real surfaces.
// Shipped the text and the module's own tests; the emission was never
// wired, so `kubic run` and `kubic tui` never told the operator the trust
// model. This file proves the notice reaches the operator ON THE COMPOSITION
// PATH (apps/kubic), not just inside the strings module: stderr for `run`
// before the first turn, the welcome block for `tui` from the first render.
// Faux lane only — zero network, zero paid tokens.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootLane } from '../../../packages/agent/src/lane/boot.js';
import {
  createSession,
  openSessionStore,
  type SessionHandle,
} from '../../../packages/agent/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import { FAUX_MODEL_REF } from '../../../packages/host/src/faux-provider.js';
import {
  NOTICE_OPT_OUT_ENV,
  noIsolationNoticeLines,
  noIsolationTuiLine,
} from '../../../packages/host/src/limits/no-isolation-notice.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runHeadlessPrompt } from './headless-run.js';
import { runTuiCommand, type TuiRunDeps, tuiLoop } from './tui-run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// One faux provider plus the model collection it registers into; the handle
// carries `state.callCount`, which is how the tests date the notice against
// the first model request (the first turn).
function fauxModels(texts: string[]): {
  models: MutableModels;
  calls: () => number;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return { models, calls: () => faux.state.callCount };
}

interface CapturedWrite {
  readonly chunk: string;
  // Model requests the faux provider had served when this chunk was written.
  readonly modelCalls: number;
}

// Captures the REAL stderr sink (not an injected one) so the assertion is
// about what an operator's terminal receives: process.stderr.write is the
// composition path's sink, and this only records its calls.
function captureStderr(calls: () => number): {
  writes: CapturedWrite[];
  restore: () => void;
} {
  const writes: CapturedWrite[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      writes.push({ chunk: String(chunk), modelCalls: calls() });
      return true;
    });
  return { writes, restore: () => spy.mockRestore() };
}

// The `warning:` lines an operator would read off stderr.
function warningLines(writes: readonly CapturedWrite[]): string[] {
  return writes
    .flatMap((write) => write.chunk.split('\n'))
    .filter((line) => line.startsWith('warning:'));
}

// Every test starts from the opt-out unset — independent of the developer's
// own shell — and unstubAllEnvs restores whatever was there before.
beforeEach(() => {
  vi.stubEnv(NOTICE_OPT_OUT_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('solo no-isolation notice on `kubic run`', () => {
  it('emits the warning on stderr before the first turn', async () => {
    const root = tmpRoot('solo-notice-run-');
    const faux = fauxModels(['all done']);
    const capture = captureStderr(faux.calls);
    let terminus: string;
    try {
      const result = await runHeadlessPrompt(
        'do it',
        {},
        {
          sessionsRoot: root,
          models: faux.models,
          env: new FakeExecutionEnv({}),
        },
      );
      terminus = result.terminus;
    } finally {
      capture.restore();
    }
    expect(terminus).toBe('completed');
    // The exact module strings, byte for byte — the surfaces never re-word.
    expect(warningLines(capture.writes)).toEqual(noIsolationNoticeLines());
    // "before the first turn": every warning line landed while the model had
    // served zero requests, and the run did reach the model afterwards.
    for (const write of capture.writes) {
      if (write.chunk.startsWith('warning:')) expect(write.modelCalls).toBe(0);
    }
    expect(faux.calls()).toBeGreaterThan(0);
  });

  it('still warns on an explicit --session resume (rule: per process start)', async () => {
    const root = tmpRoot('solo-notice-resume-');
    // Both runs are captured: the first one announces too (fresh start), and
    // an uncaptured sink would spray the suite's own output.
    const firstCapture = captureStderr(() => 0);
    let first: Awaited<ReturnType<typeof runHeadlessPrompt>>;
    try {
      first = await runHeadlessPrompt(
        'first',
        {},
        {
          sessionsRoot: root,
          models: fauxModels(['one']).models,
          env: new FakeExecutionEnv({}),
        },
      );
    } finally {
      firstCapture.restore();
    }
    expect(first.terminus).toBe('completed');
    expect(warningLines(firstCapture.writes)).toEqual(noIsolationNoticeLines());
    const capture = captureStderr(() => 0);
    try {
      const resumed = await runHeadlessPrompt(
        'second',
        { sessionId: first.sessionId },
        {
          sessionsRoot: root,
          models: fauxModels(['two']).models,
          env: new FakeExecutionEnv({}),
        },
      );
      expect(resumed.terminus).toBe('completed');
    } finally {
      capture.restore();
    }
    expect(warningLines(capture.writes)).toEqual(noIsolationNoticeLines());
  });
});

describe('solo no-isolation notice suppression', () => {
  async function runOnce(label: string): Promise<CapturedWrite[]> {
    const root = tmpRoot(`solo-notice-${label}-`);
    const capture = captureStderr(() => 0);
    try {
      const result = await runHeadlessPrompt(
        'do it',
        {},
        {
          sessionsRoot: root,
          models: fauxModels(['all done']).models,
          env: new FakeExecutionEnv({}),
        },
      );
      expect(result.terminus).toBe('completed');
    } finally {
      capture.restore();
    }
    return capture.writes;
  }

  it('KUBIC_NO_NOTICE=1 is the documented opt-out', async () => {
    vi.stubEnv(NOTICE_OPT_OUT_ENV, '1');
    expect(warningLines(await runOnce('optout'))).toEqual([]);
  });

  it('KUBIC_NO_NOTICE must be explicitly truthy to opt out', async () => {
    vi.stubEnv(NOTICE_OPT_OUT_ENV, '0');
    expect(warningLines(await runOnce('optout-zero'))).toEqual(
      noIsolationNoticeLines(),
    );
  });

  it('accepts the documented `true` spelling of the opt-out too', async () => {
    // The predicate accepts '1' and 'true' (the same two values the trust
    // env var documents). Both are pinned here: a predicate that silently
    // dropped 'true' would leave an operator who wrote it still warned, and
    // this test is what makes that impossible.
    vi.stubEnv(NOTICE_OPT_OUT_ENV, 'true');
    expect(warningLines(await runOnce('optout-true'))).toEqual([]);
  });

  it('does not treat an unrecognized opt-out value as consent', async () => {
    vi.stubEnv(NOTICE_OPT_OUT_ENV, 'yes');
    expect(warningLines(await runOnce('optout-word'))).toEqual(
      noIsolationNoticeLines(),
    );
  });
});

// The lane the TUI drives, on the prod boot shape with the faux provider
// (same pattern as tui-loop.test.ts): real lane, no network.
function fauxLaneBoot(
  root: string,
  models: MutableModels,
): TuiRunDeps['bootLane'] {
  return async (sessionId?: string) => {
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const context = BACKGROUND_CONTEXT;
    const session: SessionHandle = await createSession(
      store,
      { cwd: root },
      context,
    );
    const id = sessionId ?? session.id;
    bridge.createDir(join(id, 'journal'));
    const provider = models.getProviders()[0];
    if (provider === undefined) throw new Error('no provider registered');
    const model = models.getModels(provider.id)[0];
    if (model === undefined) throw new Error('no model registered');
    const lane = await bootLane({
      session,
      models,
      model,
      env: new FakeExecutionEnv({}),
      sessionId: id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, id, 'journal')),
    });
    return {
      sessionId: id,
      model: `${provider.id}/${model.id}`,
      loop: tuiLoop(lane),
      close: async () => {
        await lane.close(context);
        await session.release(context);
      },
    };
  };
}

interface FakeTui {
  // Derived from the seam the composition root already declares, so this
  // file never imports @kubic/tui (dep-lint, same discipline as
  // tui-regression.test.ts).
  readonly terminal: ReturnType<TuiRunDeps['createTerminal']>;
  readonly writes: string[];
  readonly started: () => number;
  readonly stopped: () => number;
  feed: (data: string) => void;
}

function fakeTerminal(width: number): FakeTui {
  const rig = terminalRig(width, 30);
  return {
    writes: rig.writes,
    started: () => rig.counts.started,
    stopped: () => rig.counts.stopped,
    terminal: rig.terminal,
    feed: rig.feed,
  };
}

async function waitFor(condition: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('solo no-isolation notice on `kubic tui`', () => {
  it('shows the line at startup, before any turn or input', async () => {
    const lines: string[] = [];
    const fake = fakeTerminal(200);
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
    await waitFor(() => fake.started() === 1);
    // No input was fed and no turn ran: whatever carries the line is the
    // startup render itself.
    const frame = fake.writes.join('');
    expect(frame).toContain(noIsolationTuiLine());
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    // The restored main screen renders the same live root, so the operator
    // reads the same line after quitting as in the alt-screen.
    expect(lines.join('\n')).toContain(noIsolationTuiLine());
  });

  it('names the faux testing provider in the welcome block while it answers', async () => {
    const fake = fakeTerminal(300);
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async () => ({ sessionId: 's1', model: FAUX_MODEL_REF }),
      },
    );
    await waitFor(() => fake.started() === 1);
    const frame = fake.writes.join('');
    // The first screen's provider row says it.
    expect(frame).toContain('faux/echo  testing provider, no model is called');
    expect(frame).toContain(noIsolationTuiLine());
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });

  it('prints the full notice on /safety after a turn', async () => {
    const root = tmpRoot('solo-notice-tui-');
    const lines: string[] = [];
    const fake = fakeTerminal(200);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, fauxModels(['all done, boss']).models),
      },
    );
    await waitFor(() => fake.started() === 1);
    for (const ch of 'say done') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('all done, boss'));
    // The notice is reachable AFTER the turn settled, not merely
    // left over from the startup frame — `/safety` prints the full text from
    // the limits module (read from what was written after the ask).
    const mark = fake.writes.length;
    for (const ch of '/safety') fake.feed(ch);
    fake.feed('\r');
    const [first, second] = noIsolationNoticeLines().map((line) =>
      line.replace(/^warning: /, ''),
    );
    await waitFor(() =>
      fake.writes
        .slice(mark)
        .join('')
        .includes(first ?? '\u0000'),
    );
    expect(fake.writes.slice(mark).join('')).toContain(
      'there is no containment',
    );
    expect(second).toContain('there is no containment');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    // The first screen (and its isolation row) left with the first prompt —
    // `/safety` above is how the line is reached after that.
    expect(lines.join('\n')).toContain('approvals on');
  });

  it('KUBIC_NO_NOTICE=1 is the documented opt-out', async () => {
    vi.stubEnv(NOTICE_OPT_OUT_ENV, '1');
    const lines: string[] = [];
    const fake = fakeTerminal(200);
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
    await waitFor(() => fake.started() === 1);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.writes.join('')).not.toContain('no isolation');
    expect(lines.join('\n')).not.toContain('no isolation');
  });
});

describe('the notice text has exactly one source', () => {
  // A second copy of the text is how the two surfaces drift apart, so the
  // emission sites must call the module, never re-state it. Test files are excluded (they quote the
  // strings on purpose); this is about production sources.
  const MARKERS = [
    'this run executes in-process with your user authority',
    'there is no containment and no prompt-injection prevention',
    'review with `kubic diff`, revert with `kubic undo`',
    'no isolation - in-process with your authority',
  ];

  function productionSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') {
          out.push(...productionSources(full));
        }
      } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('appears only in packages/host/src/limits/no-isolation-notice.ts', () => {
    const roots = ['apps', 'packages'].map((name) =>
      productionSources(join(REPO_ROOT, name)),
    );
    const hits: string[] = [];
    for (const file of roots.flat()) {
      const text = readFileSync(file, 'utf8');
      if (MARKERS.some((marker) => text.includes(marker))) {
        hits.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(hits).toEqual(['packages/host/src/limits/no-isolation-notice.ts']);
  });
});

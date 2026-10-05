// Solo no-isolation notice on the real surfaces (issue #89).
// #58 shipped the text and the module's own tests; the emission was never
// wired, so `kubic run` and `kubic tui` never told the operator the trust
// model. This file proves the notice reaches the operator ON THE COMPOSITION
// PATH (apps/kubic), not just inside the strings module: stderr for `run`
// before the first turn, the editor footer for `tui` from the first render.
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
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  FAUX_FOOTER,
  FAUX_MODEL_REF,
} from '../../../packages/host/src/faux-provider.js';
import {
  SOLO_NOTICE_OPT_OUT_ENV,
  SOLO_NOTICE_WORKER_ENV,
  soloTuiLine,
  soloWarningLines,
} from '../../../packages/host/src/limits/solo-warning.js';
import {
  createSession,
  openSessionStore,
  type SessionHandle,
} from '../../../packages/worker/src/lane/session-store.js';
import { bootSoloLane } from '../../../packages/worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runHeadlessPrompt } from './headless-run.js';
import { runTuiCommand, soloTuiLoop, type TuiRunDeps } from './tui-run.js';

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

// Every test starts from both inputs unset — independent of the developer's
// own shell — and unstubAllEnvs restores whatever was there before.
beforeEach(() => {
  vi.stubEnv(SOLO_NOTICE_WORKER_ENV, undefined);
  vi.stubEnv(SOLO_NOTICE_OPT_OUT_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('solo no-isolation notice on `kubic run` (issue #89)', () => {
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
    expect(warningLines(capture.writes)).toEqual(soloWarningLines());
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
    expect(warningLines(firstCapture.writes)).toEqual(soloWarningLines());
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
    expect(warningLines(capture.writes)).toEqual(soloWarningLines());
  });
});

describe('solo no-isolation notice suppression (issue #89)', () => {
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

  it('stays silent for an orchestrator worker session', async () => {
    vi.stubEnv(SOLO_NOTICE_WORKER_ENV, 'worker-1');
    // A worker announces readiness on stdout instead (issue #94): capture
    // it so it neither leaks into the runner's output nor goes unchecked.
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        stdout.push(String(chunk));
        return true;
      });
    let writes: CapturedWrite[];
    try {
      writes = await runOnce('worker');
    } finally {
      spy.mockRestore();
    }
    expect(warningLines(writes)).toEqual([]);
    expect(stdout.join('')).toContain('KUBIC_WORKER_READY worker-1');
  });

  it('keeps warning when KUBIC_WORKER_ID is set but empty', async () => {
    vi.stubEnv(SOLO_NOTICE_WORKER_ENV, '');
    expect(warningLines(await runOnce('empty-worker'))).toEqual(
      soloWarningLines(),
    );
  });

  it('KUBIC_NO_NOTICE=1 is the documented opt-out', async () => {
    vi.stubEnv(SOLO_NOTICE_OPT_OUT_ENV, '1');
    expect(warningLines(await runOnce('optout'))).toEqual([]);
  });

  it('KUBIC_NO_NOTICE must be explicitly truthy to opt out', async () => {
    vi.stubEnv(SOLO_NOTICE_OPT_OUT_ENV, '0');
    expect(warningLines(await runOnce('optout-zero'))).toEqual(
      soloWarningLines(),
    );
  });

  it('accepts the documented `true` spelling of the opt-out too', async () => {
    // The predicate accepts '1' and 'true' (the same two values the trust
    // env var documents). Both are pinned here: a predicate that silently
    // dropped 'true' would leave an operator who wrote it still warned, and
    // this test is what makes that impossible.
    vi.stubEnv(SOLO_NOTICE_OPT_OUT_ENV, 'true');
    expect(warningLines(await runOnce('optout-true'))).toEqual([]);
  });

  it('does not treat an unrecognized opt-out value as consent', async () => {
    vi.stubEnv(SOLO_NOTICE_OPT_OUT_ENV, 'yes');
    expect(warningLines(await runOnce('optout-word'))).toEqual(
      soloWarningLines(),
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
    const solo = await bootSoloLane({
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
      loop: soloTuiLoop(solo),
      close: async () => {
        await solo.close(context);
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

describe('solo no-isolation notice on `kubic tui` (issue #89)', () => {
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
    expect(frame).toContain(soloTuiLine());
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // The restored main screen renders the same live root, so the operator
    // reads the same line after quitting as in the alt-screen.
    expect(lines.join('\n')).toContain(soloTuiLine());
  });

  it('names the faux testing provider in the footer while it answers', async () => {
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
    expect(frame).toContain(FAUX_FOOTER);
    expect(frame).toContain(soloTuiLine());
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('keeps the line as the idle footer after a completed turn', async () => {
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
    // The footer must be back to the trust statement AFTER the turn settled,
    // not merely still present from the startup frame: drop every frame that
    // preceded the assistant text (the startup render is among them) and
    // assert on what remains. Without this slicing the assertion could pass
    // off the pre-turn frame alone, which is how a footer regression would
    // hide behind it.
    const frames = fake.writes.join('');
    const afterTurn = frames.slice(frames.lastIndexOf('all done, boss'));
    expect(afterTurn).toContain(soloTuiLine());
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain(soloTuiLine());
  });

  it('stays silent for an orchestrator worker session', async () => {
    vi.stubEnv(SOLO_NOTICE_WORKER_ENV, 'worker-1');
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
    expect(await pending).toBe(0);
    expect(fake.writes.join('')).not.toContain('no isolation');
    expect(lines.join('\n')).not.toContain('no isolation');
  });

  it('KUBIC_NO_NOTICE=1 is the documented opt-out', async () => {
    vi.stubEnv(SOLO_NOTICE_OPT_OUT_ENV, '1');
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
    expect(await pending).toBe(0);
    expect(fake.writes.join('')).not.toContain('no isolation');
    expect(lines.join('\n')).not.toContain('no isolation');
  });
});

describe('the notice text has exactly one source (issue #89)', () => {
  // A second copy of the text is how the two surfaces drift apart, and the
  // honest-claims gate pins the wording — so the emission sites must call
  // the module, never re-state it. Test files are excluded (they quote the
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

  it('appears only in packages/host/src/limits/solo-warning.ts', () => {
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
    expect(hits).toEqual(['packages/host/src/limits/solo-warning.ts']);
  });
});

describe('the notice is documented where the operator looks (issue #89)', () => {
  // The drift gate for the docs half of the criterion: the pages must state
  // when the warning appears (every process start), where it goes (stderr for
  // run, editor footer for tui), what suppresses it, and the opt-out's exact
  // spelling — read from the module, so renaming the env var without the docs
  // fails here rather than in a user's terminal.
  const commandsPage = readFileSync(
    join(REPO_ROOT, 'docs', 'cli', 'commands.md'),
    'utf8',
  );
  const soloPage = readFileSync(
    join(REPO_ROOT, 'docs', 'architecture', 'solo.md'),
    'utf8',
  );

  it('states the notice, its sink and the suppression rule', () => {
    expect(commandsPage).toContain('no isolation');
    expect(commandsPage).toContain('stderr');
    expect(commandsPage).toContain('before the first turn');
    expect(commandsPage).toContain('per process start');
  });

  it('names the shipped suppression env vars, exactly as the module does', () => {
    expect(commandsPage).toContain(SOLO_NOTICE_WORKER_ENV);
    // The opt-out is documented with the value it actually needs: a bare
    // mention of the name would leave an operator guessing at `=1`.
    expect(commandsPage).toContain(`${SOLO_NOTICE_OPT_OUT_ENV}=1`);
  });

  it('keeps the solo architecture page describing both surfaces as shipped', () => {
    // solo.md asserted "every fresh start prints the warning, and the TUI
    // carries the same one-line statement" while NOTHING emitted it (issue
    // #89's premise) — a doc claim outrunning the code. The sentence now
    // describes exactly what ships, and both surfaces it names are the ones
    // the prod tests above exercise: run = the three-line stderr block, tui =
    // the one-line editor footer.
    expect(soloPage).toContain('announced, not buried');
    expect(soloPage).toMatch(
      /`kubic run` prints the three-line warning block on\s+stderr before the first turn/,
    );
    expect(soloPage).toMatch(
      /`kubic tui` carries the one-line form in the\s+editor footer from the first render/,
    );
    expect(soloPage).toContain('per process start, not per\nsession');
    expect(soloPage).toContain(SOLO_NOTICE_WORKER_ENV);
    expect(soloPage).toContain(`${SOLO_NOTICE_OPT_OUT_ENV}=1`);
    // The claim is anchored to the strings module so the page cannot name a
    // different source than the code uses.
    expect(soloPage).toContain('packages/host/src/limits/solo-warning.ts');
  });
});

// `/model provider/id` on the real `kubic tui` loop, and the audit identity
// of the model the lane runs (issue #227; §38.1, §60). The prod boot
// (bootTuiLane) is driven through the real alt-screen key path with two
// faux providers, so the switch is proven by the NEXT request being answered
// on the new provider — not only by a label. Zero network, zero paid tokens.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  auditLedgerDir,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
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

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

// Two faux providers: `faux` (default pick, answers 'from faux') and `alt`
// (only reached by a pin or a `/model` switch). `altResponses` lets the
// audit test give alt a destructive tool call.
function twoProviders(
  altResponses: FauxMessage[] = [fauxAssistantMessage('from alt')],
): MutableModels {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      // `big` reasons; `small` does not — the ladder the `/thinking`
      // re-clamp test needs (#328 review).
      { id: 'big', contextWindow: 200000, reasoning: true },
      { id: 'small', contextWindow: 120000 },
    ],
  });
  faux.setResponses([fauxAssistantMessage('from faux')]);
  models.setProvider(faux.provider);
  const alt = fauxProvider({
    provider: 'alt',
    models: [{ id: 'm1', contextWindow: 100000 }],
  });
  alt.setResponses(
    altResponses.map((message) =>
      // pi-durable dispatches the calls of a `toolUse` turn.
      message.content.some((part) => part.type === 'toolCall')
        ? fauxToolUse(message.content)
        : message,
    ),
  );
  models.setProvider(alt.provider);
  return models;
}

// One provider whose faux factory records every request's options: the
// thinking level travels there as `reasoning` (#328).
function thinkingProviders(
  record: (options: { reasoning?: string } | undefined) => void,
): MutableModels {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'big', contextWindow: 200000, reasoning: true }],
  });
  const factory = (
    _context: unknown,
    options?: { reasoning?: string },
  ): FauxMessage => {
    record(options);
    return fauxAssistantMessage('from faux');
  };
  faux.setResponses([factory, factory, factory, factory]);
  models.setProvider(faux.provider);
  return models;
}

function fakeTerminal(width: number) {
  return terminalRig(width, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function type(fake: ReturnType<typeof fakeTerminal>, text: string): void {
  for (const ch of text) fake.feed(ch);
  fake.feed('\r');
}

function sessionDirs(root: string): string[] {
  return readdirSync(root).filter((entry) =>
    statSync(join(root, entry)).isDirectory(),
  );
}

// The model a fresh attach resumes on: the committed `pi.agent` document,
// read through the #148 'stored' rule (a boot with no pin keeps it).
async function storedModel(
  sessionsRoot: string,
  id: string,
): Promise<{ provider?: string; modelId?: string } | undefined> {
  const boot = await bootTuiLane(id, {
    sessionsRoot,
    models: twoProviders(),
    env: new NodeExecutionEnv(sessionsRoot),
  });
  try {
    const [provider, modelId] = boot.model.split('/');
    return { provider, modelId };
  } finally {
    await boot.close?.();
  }
}

describe('/model on the kubic tui path (issue #227, criterion 5)', () => {
  it('switches the live lane and the frame shows the new model', async () => {
    const workspace = tmpRoot('tui-227-switch-ws-');
    const sessionsRoot = tmpRoot('tui-227-switch-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    let sessionId = '';
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) => {
      const boot = await bootTuiLane(sid, {
        sessionsRoot,
        models: twoProviders(),
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
        model: { provider: 'faux', id: 'big' },
      });
      sessionId = boot.sessionId;
      return boot;
    };
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane,
      },
    );
    await waitFor(() => fake.counts.started === 1);

    type(fake, '/model alt/m1');
    await waitFor(() => fake.frame.includes('model: alt/m1'));
    // The status line moved too, not only the notice row: it reads
    // `● <model> · <thinking>` (issue #453).
    await waitFor(() => fake.frame.includes('● alt/m1 · '));
    // The switch is real: the next request is answered on the alt provider.
    type(fake, 'hello');
    await waitFor(() => fake.frame.includes('from alt'));

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(sessionId).not.toBe('');
    // The session recorded the new model, so an attach resumes on it.
    expect(await storedModel(sessionsRoot, sessionId)).toMatchObject({
      provider: 'alt',
      modelId: 'm1',
    });
  });

  it('does not resurrect an accepted /model steer (#334 review round 2)', async () => {
    // Alt+Enter submits like Enter when idle. A `/model` steer the loop
    // ACCEPTED ran the command, so the draft must not come back as if it had
    // been refused (the pre-fix branch restored on anything but 'queued').
    const workspace = tmpRoot('tui-334-steer-ws-');
    const sessionsRoot = tmpRoot('tui-334-steer-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models: twoProviders(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of '/model alt/m1') fake.feed(ch);
    fake.feed('\x1b\r');
    await waitFor(() => fake.frame.includes('model: alt/m1'));
    // Ctrl-D quits on the empty editor and leaves the notice row as it was.
    fake.feed('\x04');
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('switched');
    // The editor row at quit is empty: nothing resurrected the command.
    expect(doc).not.toContain('/model alt/m1');
  });

  it('switches the thinking level and sends it with the next request (#328)', async () => {
    const workspace = tmpRoot('tui-328-thinking-ws-');
    const sessionsRoot = tmpRoot('tui-328-thinking-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    const seen: Array<string | undefined> = [];
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models: thinkingProviders((options) =>
              seen.push(options?.reasoning),
            ),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // Issue #461: a bare /thinking opens the picker on the boot level; esc
    // keeps it. An unknown level is refused by name with the vocabulary.
    type(fake, '/thinking');
    await waitFor(() => fake.frame.includes('┌─ Thinking'));
    expect(fake.frame).toContain('● off  current');
    fake.feed('\x1b');
    await waitFor(() =>
      fake.frame.includes('thinking: off (picker cancelled)'),
    );
    type(fake, '/thinking bogus');
    await waitFor(() => fake.frame.includes("unknown thinking level 'bogus'"));
    // Chosen in the picker, the switch rides the NEXT request as `reasoning`.
    const picking = fake.mark();
    type(fake, '/thinking');
    await waitFor(() => fake.since(picking).includes('┌─ Thinking'));
    for (const ch of 'high') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('thinking: high'));
    type(fake, 'hello');
    await waitFor(() => fake.frame.includes('from faux'));
    expect(seen).toContain('high');
    // A level above what the model supports clamps, and the footer says so.
    type(fake, '/thinking xhigh');
    await waitFor(() => fake.frame.includes('(clamped from xhigh)'));
    // Alt+T cycles from high back to off (this model's ladder ends at high).
    const mark = fake.writes.length;
    fake.feed('\u001bt');
    await waitFor(() =>
      fake.writes.slice(mark).join('').includes('thinking: off'),
    );
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // The status line carries the live level, not the boot one.
    expect(lines.join('\n')).toMatch(/● \S+ · off/);
  });

  it('picks a model from the Alt+M overlay (#328)', async () => {
    const workspace = tmpRoot('tui-328-picker-ws-');
    const sessionsRoot = tmpRoot('tui-328-picker-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    let sessionId = '';
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) => {
          const boot = await bootTuiLane(sid, {
            sessionsRoot,
            models: twoProviders(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          });
          sessionId = boot.sessionId;
          return boot;
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // Alt+M opens the picker: one group per provider, the live model
    // marked (issue #461).
    fake.feed('\u001bm');
    await waitFor(() => fake.frame.includes('● big  current'));
    expect(fake.frame).toContain('ALT');
    expect(fake.frame).toContain('m1');
    // Move to the next row and select it: the same switch path as /model.
    fake.feed('\u001b[B');
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('model: faux/small (switched)'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain('faux/small');
    // The picker switched the real lane: a fresh attach resumes on it.
    expect(await storedModel(sessionsRoot, sessionId)).toMatchObject({
      provider: 'faux',
      modelId: 'small',
    });
  });

  it('switches the model from the ^P palette (#460)', async () => {
    const workspace = tmpRoot('tui-460-palette-ws-');
    const sessionsRoot = tmpRoot('tui-460-palette-sessions-');
    const fake = fakeTerminal(120);
    let sessionId = '';
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) => {
          const boot = await bootTuiLane(sid, {
            sessionsRoot,
            models: twoProviders(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          });
          sessionId = boot.sessionId;
          return boot;
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // Ctrl-P: the grouped palette with its own key hints; the catalog
    // arrives after the first frame and the live model is marked.
    fake.feed('\x10');
    await waitFor(() => fake.frame.includes('COMMANDS'));
    expect(fake.frame).toContain('tab next group');
    await waitFor(() => fake.frame.includes('faux/big  current'));
    // Esc closes it and the hint row is the editor's again.
    const mark = fake.mark();
    fake.feed('\x1b');
    await waitFor(() => fake.since(mark).includes('^P palette'));
    const reopened = fake.mark();
    fake.feed('\x10');
    for (const ch of 'small') fake.feed(ch);
    // The catalog lands after the first frame; the best match is selected.
    await waitFor(() => fake.since(reopened).includes('▌   faux/small'));
    // ⏎ switches through the /model path.
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('model: faux/small (switched)'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(await storedModel(sessionsRoot, sessionId)).toMatchObject({
      provider: 'faux',
      modelId: 'small',
    });
  });

  it('re-clamps the thinking level when /model moves to a shorter ladder (#328 review)', async () => {
    const workspace = tmpRoot('tui-328-clamp-ws-');
    const sessionsRoot = tmpRoot('tui-328-clamp-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models: twoProviders(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // `faux/big` reasons: high is on its ladder.
    type(fake, '/thinking high');
    await waitFor(() => fake.frame.includes('thinking: high'));
    // `faux/small` does not: the switch must re-clamp the stored level.
    type(fake, '/model faux/small');
    await waitFor(() => fake.frame.includes('model: faux/small (switched)'));
    // The picker's current row is the clamped level.
    const mark = fake.writes.length;
    type(fake, '/thinking');
    await waitFor(() =>
      fake.writes.slice(mark).join('').includes('● off  current'),
    );
    fake.feed('\x1b');
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('cancels the picker with Esc, leaving the model alone (#328)', async () => {
    const workspace = tmpRoot('tui-328-cancel-ws-');
    const sessionsRoot = tmpRoot('tui-328-cancel-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models: twoProviders(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\u001bm');
    await waitFor(() => fake.frame.includes('● big  current'));
    fake.feed('\u001b');
    await waitFor(() => fake.frame.includes('(picker cancelled)'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // Still the boot model.
    expect(lines.join('\n')).toContain('faux/big');
    expect(lines.join('\n')).not.toContain('faux/small');
  });

  it('reports the current model and refuses an unknown one by name', async () => {
    const workspace = tmpRoot('tui-227-report-ws-');
    const sessionsRoot = tmpRoot('tui-227-report-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models: twoProviders(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'faux', id: 'big' },
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);

    // Issue #461: a bare /model opens the picker; esc keeps the model.
    type(fake, '/model');
    await waitFor(() => fake.frame.includes('┌─ Model'));
    fake.feed('\x1b');
    await waitFor(() =>
      fake.frame.includes('model: faux/big (picker cancelled)'),
    );

    type(fake, '/model alt/nope');
    await waitFor(() => fake.frame.includes('model switch failed'));
    expect(fake.frame).toContain('unknown model');

    // A malformed argument is refused by name too, without touching the lane.
    type(fake, '/model nope');
    await waitFor(() =>
      fake.frame.includes("model switch failed: --model must be 'provider/id'"),
    );

    // Still the original model: the failed switch did not move the lane.
    type(fake, 'hello');
    await waitFor(() => fake.frame.includes('from faux'));

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain('[SOLO] approvals on');
  });
});

describe('tui audit identity (issue #227, criterion 4)', () => {
  it('an approval record carries the model provider/id the lane runs', async () => {
    const workspace = tmpRoot('tui-227-audit-ws-');
    const sessionsRoot = tmpRoot('tui-227-audit-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    let sessionId = '';
    const models = twoProviders([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
      ]),
      fauxAssistantMessage('after deny'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        // Issue #315's arming delay is pinned off so the deny keypress below
        // registers the moment the card appears (as the HEAD approval
        // tests do).
        approvalArmingMs: 0,
        bootLane: async (sid, answer) => {
          const boot = await bootTuiLane(sid, {
            sessionsRoot,
            models,
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
            model: { provider: 'alt', id: 'm1' },
          });
          sessionId = boot.sessionId;
          return boot;
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);

    type(fake, 'clean up');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    fake.feed('d'); // deny: the command never runs, the decision is audited
    await waitFor(() => fake.frame.includes('after deny'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);

    const records = readAuditLedger(auditLedgerDir(workspace));
    const record = records.find((r) => r.what === 'tool:bash');
    expect(record).toBeDefined();
    expect(record?.model).toMatchObject({ provider: 'alt', id: 'm1' });
    expect(record?.agent.session).toBe(sessionId);
    expect(sessionId).not.toBe('');
    expect(sessionDirs(sessionsRoot)).toContain(sessionId);
  });
});

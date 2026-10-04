// `/model provider/id` on the real `kubic tui` loop, and the audit identity
// of the model the lane runs (issue #227; §38.1, §60). The prod boot
// (bootTuiLane) is driven through the real alt-screen key path with two
// faux providers, so the switch is proven by the NEXT request being answered
// on the new provider — not only by a label. Zero network, zero paid tokens.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

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
      { id: 'big', contextWindow: 200000 },
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
        ? { ...message, stopReason: 'toolUse' as const }
        : message,
    ),
  );
  models.setProvider(alt.provider);
  return models;
}

function fakeTerminal(width: number) {
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    get frame(): string {
      return writes.join('');
    },
    feed: (data: string) => {
      handler?.(data);
    },
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {
        counts.stopped += 1;
      },
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return width;
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
    },
  };
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
    // The status bar moved too, not only the footer: its model line is
    // `<model> • thinking …`.
    await waitFor(() => fake.frame.includes('alt/m1 • thinking'));
    // The switch is real: the next request is answered on the alt provider.
    type(fake, 'hello');
    await waitFor(() => fake.frame.includes('from alt'));

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

    type(fake, '/model');
    await waitFor(() => fake.frame.includes('model: faux/big'));

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
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain('approvals:on');
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
        // registers the moment the overlay appears (as the HEAD approval
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
    await waitFor(() => fake.frame.includes('Approval required'));
    fake.feed('d'); // deny: the command never runs, the decision is audited
    await waitFor(() => fake.frame.includes('after deny'));
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

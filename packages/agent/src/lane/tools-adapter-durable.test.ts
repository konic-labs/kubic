// Kubic operations on the real pi-durable harness.
// End to end with the faux provider and pi-durable JSONL storage — the
// format Kubic ships — so the harness contracts the adapter leans on are
// pinned rather than assumed:
//
// - the journal carries the pi-durable call id (`api.callId`), and Kubic's
//   own result text survives the harness output bound untouched
// - an unsafe call interrupted mid-effect reaches the model as an
//   `interrupted` error result carrying the output it had committed, and is
//   never re-executed; a safe one reruns
// - `api.memo` answers a replayed invocation from the durable task record
//   (memos are durable and first-writer-wins)
//
// Folds this boot into the shared faux harness-test factory.
import type { ProcessHandle, ShellResult, SpawnOptions } from '@kubic/exec/env';
import { FileJournalStore } from '@kubic/exec/journal';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  LiveDoc,
  openNodeJsonlStorage,
  type ToolRegistration,
  ToolResultEntry,
  Type,
} from '../pi-boundary.js';
import { OperationKillRegistry } from './abort.js';
import { type KubicToolContext, kubicToolsToPiTools } from './tools-adapter.js';

// Types come from the boundary's functions instead of new re-exports: the
// Pi 1.0 surface is CODEOWNERS-gated and a sibling issue edits it too.
type Models = ReturnType<typeof createModels>;
type Registry = ReturnType<typeof createRegistry>;
type Faux = ReturnType<typeof fauxProvider>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Reject with the signal's reason once it aborts; for effects that hang until cancelled. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

type ToolResult = {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  text: string;
  details?: unknown;
};

function asResult(entry: EntryRecord): ToolResult | undefined {
  const message = entry.model?.[0];
  if (message?.role !== 'toolResult') return undefined;
  return {
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isError: message.isError,
    text: message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(''),
    ...(message.details === undefined ? {} : { details: message.details }),
  };
}

/** Tool results of one conversation, oldest first. */
async function results(
  root: ReturnType<Harness['root']> extends Promise<infer C> ? C : never,
): Promise<ToolResult[]> {
  const page = await root.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
  return [...page.items]
    .reverse()
    .filter((entry) => ToolResultEntry.is(entry))
    .map((entry) => asResult(entry))
    .filter((result): result is ToolResult => result !== undefined);
}

interface Chat {
  faux: Faux;
  models: Models;
  registry: Registry;
}

function chat(): Chat {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, registry: createRegistry() };
}

/** One harness over `dir`'s JSONL storage, with the Kubic tools installed. */
async function openChat(
  dir: string,
  setup: Chat,
): Promise<{
  harness: Harness;
  root: Awaited<ReturnType<Harness['root']>>;
}> {
  const model = setup.faux.getModel();
  const harness = await Harness.open(
    await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
    { models: setup.models, registry: setup.registry },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  harness.resume();
  return { harness, root };
}

function toolContext(options: {
  env?: FakeExecutionEnv;
  journal?: FileJournalStore;
}): KubicToolContext {
  return {
    env: options.env ?? new FakeExecutionEnv({}),
    sessionId: 's1',
    agentId: 'root',
    kills: new OperationKillRegistry(),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  };
}

// A shell whose first spawn hangs (the effect started, the intent is
// committed, the process never finishes — what a crash leaves behind) and
// whose later spawns settle: the resume cases need exactly that state.
// `firstOutput` is what the hanging child reports before it blocks.
function crashableEnv(options: { spawned: () => void; firstOutput?: string }): {
  env: FakeExecutionEnv;
  spawns: () => number;
} {
  const firstOutput = options.firstOutput ?? 'partial build output\n';
  const base = new FakeExecutionEnv({});
  let spawns = 0;
  let settle: ((result: ShellResult) => void) | undefined;
  const env = Object.assign(Object.create(base) as FakeExecutionEnv, {
    shell: {
      spawn: (
        _cmd: string,
        _args: string[],
        opts: SpawnOptions,
      ): ProcessHandle => {
        spawns += 1;
        if (spawns > 1) {
          const result: ShellResult = {
            exitCode: 0,
            stdout: 'recovered\n',
            stderr: '',
            provenance: base.provenance,
          };
          opts.onUpdate?.(
            { stdout: result.stdout, stderr: '', exitCode: null },
            undefined,
          );
          return { pid: 2, wait: async () => result, kill: () => undefined };
        }
        opts.onUpdate?.(
          { stdout: firstOutput, stderr: '', exitCode: null },
          undefined,
        );
        options.spawned();
        return {
          pid: 1,
          wait: () => new Promise<ShellResult>((resolve) => (settle = resolve)),
          kill: () =>
            settle?.({
              exitCode: 143,
              stdout: firstOutput,
              stderr: '',
              provenance: base.provenance,
            }),
        };
      },
    },
  });
  return { env, spawns: () => spawns };
}

const toolUse = (calls: Parameters<typeof fauxAssistantMessage>[0]) =>
  fauxAssistantMessage(calls, { stopReason: 'toolUse' });

describe('Kubic tools on the pi-durable harness', () => {
  it('journals a lane write under the pi-durable call id', async () => {
    const dir = tempDir('kubic-durable-journal-');
    const env = new FakeExecutionEnv({});
    const journal = new FileJournalStore(tempDir('kubic-durable-j-'));
    const context = toolContext({ env, journal });
    const setup = chat();
    setup.registry.install(
      defineExtension({ name: 'kubic', tools: kubicToolsToPiTools(context) }),
    );
    setup.faux.setResponses([
      toolUse([
        fauxToolCall(
          'write',
          { path: 'n.txt', content: 'hi\n' },
          { id: 'call-write-1' },
        ),
      ]),
      fauxAssistantMessage('wrote it'),
    ]);
    const { harness, root } = await openChat(dir, setup);

    const submission = await root.submit(
      { type: 'input', content: 'write the file' },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');

    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('create');
    // The model's own tool call id, straight from api.callId.
    expect(entries[0]?.toolCallId).toBe('call-write-1');
    expect(env.fs.readFile('n.txt')).toBe('hi\n');
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("keeps Kubic's own truncation and result text intact past the harness bound", async () => {
    const dir = tempDir('kubic-durable-read-');
    const env = new FakeExecutionEnv({});
    const line = (n: number) =>
      `${String(n).padStart(5, '0')} ${'y'.repeat(93)}`;
    env.fs.writeFile(
      'wide.txt',
      `${Array.from({ length: 1000 }, (_, i) => line(i + 1)).join('\n')}\n`,
    );
    const setup = chat();
    setup.registry.install(
      defineExtension({
        name: 'kubic',
        tools: kubicToolsToPiTools(toolContext({ env })),
      }),
    );
    setup.faux.setResponses([
      toolUse([
        fauxToolCall('read', { path: 'wide.txt' }, { id: 'call-read-1' }),
      ]),
      fauxAssistantMessage('read it'),
    ]);
    const { harness, root } = await openChat(dir, setup);

    await (
      await root.submit(
        { type: 'input', content: 'read it' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);

    const [result] = await results(root);
    const lines = result?.text.split('\n') ?? [];
    // Kubic's window (51200B, whole lines) is the bound that applies: the
    // header is Kubic's, the last line of its window is present, and the
    // harness added no truncation diagnostic of its own.
    expect(lines[0]).toBe(
      '[read wide.txt: lines 1-512 of at least 1000; more: offset=513; output clipped at 51200B]',
    );
    expect(lines[512]).toBe(line(512));
    expect(result?.text).not.toContain(line(513));
    expect(result?.text).not.toContain('<harness>');
    expect(result?.isError).toBe(false);
    await harness.close(BACKGROUND_CONTEXT);
  });

  it('answers an interrupted unsafe call with its committed output instead of rerunning it', async () => {
    const dir = tempDir('kubic-durable-unsafe-');
    const spawned = deferred();
    const shell = crashableEnv({ spawned: spawned.resolve });
    const setup = chat();
    const tools = kubicToolsToPiTools(toolContext({ env: shell.env }));
    setup.registry.install(defineExtension({ name: 'kubic', tools }));
    setup.faux.setResponses([
      toolUse([
        fauxToolCall('bash', { command: 'make build' }, { id: 'call-bash-1' }),
      ]),
      fauxAssistantMessage('after the failure'),
    ]);
    let opened = await openChat(dir, setup);
    const submission = await opened.root.submit(
      { type: 'input', content: 'run it' },
      BACKGROUND_CONTEXT,
    );
    // The child is hanging: the call's intent is committed. `api.output` is
    // committed at most every 100 ms (the harness throttle), so wait for the
    // streamed text to reach the live document — the crash window a real
    // SIGKILL would leave.
    await spawned.promise;
    await vi.waitFor(async () => {
      const live = await opened.harness.snapshot(
        LiveDoc,
        opened.root.id,
        BACKGROUND_CONTEXT,
      );
      expect(live?.tools?.[0]?.output).toContain('partial build output');
    });
    await opened.harness.close(BACKGROUND_CONTEXT);

    opened = await openChat(dir, setup);
    expect(
      (
        await (
          await opened.harness.submission(submission.id, BACKGROUND_CONTEXT)
        )?.wait(BACKGROUND_CONTEXT)
      )?.status,
    ).toBe('done');

    const [result] = await results(opened.root);
    expect(result?.toolCallId).toBe('call-bash-1');
    expect(result?.isError).toBe(true);
    // The output api.output had streamed is what the model gets, and the
    // effect never ran a second time.
    expect(result?.text).toContain('--- stdout ---\npartial build output\n');
    expect(result?.text).toContain('was interrupted');
    expect(shell.spawns()).toBe(1);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });

  it('bounds an interrupted call to the op cap and keeps the stream tail', async () => {
    const dir = tempDir('kubic-durable-bounded-');
    const spawned = deferred();
    // ~360 KB of output — well past the 4×64 KiB window bash retains — with
    // a marker line at each end.
    const lines = Array.from(
      { length: 4000 },
      (_, i) => `0000line ${String(i).padStart(5, '0')} ${'x'.repeat(80)}`,
    );
    lines[0] = 'HEAD'.padEnd(88, 'x');
    lines[lines.length - 1] = 'TAIL'.padEnd(88, 'x');
    const shell = crashableEnv({
      spawned: spawned.resolve,
      firstOutput: `${lines.join('\n')}\n`,
    });
    const setup = chat();
    setup.registry.install(
      defineExtension({
        name: 'kubic',
        tools: kubicToolsToPiTools(toolContext({ env: shell.env })),
      }),
    );
    setup.faux.setResponses([
      toolUse([
        fauxToolCall('bash', { command: 'chatty' }, { id: 'call-bash-1' }),
      ]),
      fauxAssistantMessage('after the failure'),
    ]);
    let opened = await openChat(dir, setup);
    const submission = await opened.root.submit(
      { type: 'input', content: 'run it' },
      BACKGROUND_CONTEXT,
    );
    await spawned.promise;
    await vi.waitFor(async () => {
      const live = await opened.harness.snapshot(
        LiveDoc,
        opened.root.id,
        BACKGROUND_CONTEXT,
      );
      expect(live?.tools?.[0]?.output).toContain('TAIL');
    });
    await opened.harness.close(BACKGROUND_CONTEXT);

    opened = await openChat(dir, setup);
    await (
      await opened.harness.submission(submission.id, BACKGROUND_CONTEXT)
    )?.wait(BACKGROUND_CONTEXT);

    const [result] = await results(opened.root);
    expect(result?.isError).toBe(true);
    // Without the bash window this content would be the 8 MiB backstop: the
    // retained tail must stay the same order of magnitude as a capped bash
    // result instead.
    expect((result?.text ?? '').length).toBeLessThan(4 * 64 * 1024 + 4096);
    // Tail, not head — what bash's own clip() keeps ("endings carry the
    // error"), so the model is not left with the beginning of a chatty call.
    expect(result?.text).toContain('TAIL');
    expect(result?.text).not.toContain('HEAD');
    expect(result?.text).toContain('Output truncated');
    expect(shell.spawns()).toBe(1);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });

  it('reruns a safe call interrupted the same way', async () => {
    const dir = tempDir('kubic-durable-safe-');
    const spawned = deferred();
    const shell = crashableEnv({ spawned: spawned.resolve });
    const setup = chat();
    const bash = kubicToolsToPiTools(toolContext({ env: shell.env })).find(
      (tool) => tool.name === 'bash',
    ) as ToolRegistration;
    // bash is Kubic's only crashable op (its effect is a child process, and
    // git's child is not abortable), so the shipped `read`-style
    // safe path is exercised with bash's own registration declared safe —
    // both the stored and the current policy then say safe.
    const tools = [{ ...bash, replay: 'safe' as const }];
    setup.registry.install(defineExtension({ name: 'kubic', tools }));
    setup.faux.setResponses([
      toolUse([
        fauxToolCall('bash', { command: 'make build' }, { id: 'call-bash-1' }),
      ]),
      fauxAssistantMessage('after the recovery'),
    ]);
    let opened = await openChat(dir, setup);
    const submission = await opened.root.submit(
      { type: 'input', content: 'run it' },
      BACKGROUND_CONTEXT,
    );
    await spawned.promise;
    await opened.harness.close(BACKGROUND_CONTEXT);

    opened = await openChat(dir, setup);
    expect(
      (
        await (
          await opened.harness.submission(submission.id, BACKGROUND_CONTEXT)
        )?.wait(BACKGROUND_CONTEXT)
      )?.status,
    ).toBe('done');

    const [result] = await results(opened.root);
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain('recovered');
    expect(shell.spawns()).toBe(2);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });

  it('answers a replayed invocation with the memo the crashed attempt stored', async () => {
    const dir = tempDir('kubic-durable-memo-');
    const stored = deferred();
    const setup = chat();
    let runs = 0;
    // A probe, not a Kubic op: no shipped op memoizes today, and none of the
    // ops that RERUN touch a memo (every never-replay op is `unsafe`, which
    // pi-durable never re-enters). This pins the store the adapter routes
    // `ToolInvocation.getMemo`/`setMemo`/`memoOnce` to: durable per task,
    // first-writer-wins, and answered across a crash — so the first op that
    // needs a durable deferred answer gets one for free.
    const probe = defineTool({
      name: 'memo_probe',
      description: 'records a durable memo before it is interrupted',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async (_args, api, callContext) => {
        runs += 1;
        const won = await api.memo('probe', `attempt ${runs}`, callContext);
        stored.resolve();
        const signal = callContext.abortSignal;
        if (signal === undefined) throw new Error('no abort signal');
        if (runs === 1) await aborted(signal);
        return {
          content: [{ type: 'text' as const, text: `memo=${String(won)}` }],
        };
      },
    });
    setup.registry.install(defineExtension({ name: 'kubic', tools: [probe] }));
    setup.faux.setResponses([
      toolUse([fauxToolCall('memo_probe', {}, { id: 'call-memo-1' })]),
      fauxAssistantMessage('done'),
    ]);
    let opened = await openChat(dir, setup);
    const submission = await opened.root.submit(
      { type: 'input', content: 'probe' },
      BACKGROUND_CONTEXT,
    );
    await stored.promise;
    await opened.harness.close(BACKGROUND_CONTEXT);

    opened = await openChat(dir, setup);
    await (
      await opened.harness.submission(submission.id, BACKGROUND_CONTEXT)
    )?.wait(BACKGROUND_CONTEXT);

    const [result] = await results(opened.root);
    expect(runs).toBe(2);
    expect(result?.text).toBe('memo=attempt 1');
    await opened.harness.close(BACKGROUND_CONTEXT);
  });
});

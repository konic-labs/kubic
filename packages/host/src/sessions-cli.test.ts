// `kubic sessions` CLI (issue #14; #318/#400 for the attach transcript).
// The attach transcript is read through the shared pi-durable adapter, so
// the fixtures are REAL sessions: a session created by the store, booted
// into a pi-durable Harness over MemoryStorage-free JSONL storage with the
// faux provider (zero network, zero paid tokens), and released before the
// CLI attaches to it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  GenerationTask,
  Harness,
  ToolResultEntry,
} from '../../worker/src/pi-boundary.js';
import { runSessionsCommand } from './sessions-cli.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

// One real session with one faux turn stored, released for the CLI to attach.
async function seededSession(
  root: string,
  options: {
    cwd?: string;
    responses?: ReturnType<typeof fauxAssistantMessage>[];
  } = {},
): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: options.cwd ?? '/work' },
    BACKGROUND_CONTEXT,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    session.storage,
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  });
  faux.setResponses(
    options.responses ?? [fauxAssistantMessage('cli hello back')],
  );
  await (
    await conversation.submit(
      { type: 'input', content: 'cli hello' },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  await session.release(BACKGROUND_CONTEXT);
  return session.id;
}

describe('sessions CLI (issue #14, slice F)', () => {
  it('creates and lists sessions', async () => {
    const root = tmpRoot();
    const o = out();
    const created = await runSessionsCommand(
      { command: 'create', cwd: '/work' },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(created).toBe(0);
    expect(o.lines.length).toBe(1);
    const id = o.lines[0] ?? '';
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    // A separate sink: the listing itself must carry the session and its cwd.
    const listing = out();
    const listed = await runSessionsCommand(
      { command: 'list' },
      {
        sessionsRoot: root,
        out: listing.write,
      },
    );
    expect(listed).toBe(0);
    expect(
      listing.lines.some((line) => line.includes(id) && line.includes('/work')),
    ).toBe(true);
  });

  it('list --json prints [] when there are no sessions', async () => {
    const o = out();
    const code = await runSessionsCommand(
      { command: 'list', json: true },
      {
        sessionsRoot: tmpRoot(),
        out: o.write,
      },
    );
    expect(code).toBe(0);
    expect(o.lines).toEqual(['[]']);
  });

  it('marks a Pi 0.87 session in the listing as legacy', async () => {
    const root = tmpRoot();
    // Exactly what 0.87's JsonlSessionRepo wrote: <root>/--<cwd>--/<ts>_<id>.jsonl
    // whose first line is the format-4 header.
    const dir = join(root, '--work--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-01-01T00-00-00-000Z_legacy-1.jsonl'),
      `${JSON.stringify({
        v: 4,
        kind: 'header',
        id: 'legacy-1',
        storageVersion: 1,
        createdAt: 1_700_000_000_000,
        cwd: '/work',
      })}\n`,
    );
    const o = out();
    const code = await runSessionsCommand(
      { command: 'list' },
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('legacy-1');
    expect(o.lines.join('\n')).toContain('(legacy pi 0.87');
  });

  it('list --json emits one {id, cwd} object per session', async () => {
    const root = tmpRoot();
    const o = out();
    await runSessionsCommand(
      { command: 'create', cwd: '/work' },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    const listing = out();
    await runSessionsCommand(
      { command: 'list', json: true },
      {
        sessionsRoot: root,
        out: listing.write,
      },
    );
    expect(JSON.parse(listing.lines.join('\n'))).toEqual([
      { id: o.lines[0], cwd: '/work' },
    ]);
  });

  it('attaches and shows the transcript tail as readable turn lines', async () => {
    const root = tmpRoot();
    const id = await seededSession(root);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'attach', id, tail: 5 },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(code).toBe(0);
    expect(o.lines[0]).toBe(`session ${id}  cwd=/work`);
    expect(o.lines).toContain('user: cli hello');
    expect(o.lines).toContain('assistant: cli hello back');
    // #318: no raw truncated JSON entry anywhere on the attach output.
    expect(o.lines.join('\n')).not.toContain('"role"');
  });

  it('shows a tool call and its result on their own lines', async () => {
    const root = tmpRoot();
    const id = await seededSession(root, {
      responses: [
        fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ],
    });
    const o = out();
    const code = await runSessionsCommand(
      { command: 'attach', id, tail: 10 },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(code).toBe(0);
    const assistant = o.lines.find((line) =>
      line.startsWith('assistant: (no text) [tools: read]'),
    );
    expect(assistant).toBeDefined();
    expect(o.lines.some((line) => line.startsWith('tool-result read:'))).toBe(
      true,
    );
  });

  it('honours --tail over the transcript items', async () => {
    const root = tmpRoot();
    const id = await seededSession(root);
    const o = out();
    await runSessionsCommand(
      { command: 'attach', id, tail: 1 },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(o.lines.at(-1)).toBe('assistant: cli hello back');
  });

  it('strips terminal control sequences out of stored transcript text', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const harness = await Harness.open(
      session.storage,
      { models: fauxModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    // A hostile tool result: clearing the screen and recolouring the
    // operator's terminal is the payload, not the text.
    await harness.commit(
      (tx) =>
        tx.appendEntry(ToolResultEntry, conversation.id, {
          data: { diagnostics: [] },
          model: [
            {
              role: 'toolResult',
              toolCallId: 'call-evil',
              toolName: 'bash',
              content: [{ type: 'text', text: '\u001b[2J\u001b[31mowned' }],
              isError: false,
              timestamp: Date.now(),
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    await harness.close(BACKGROUND_CONTEXT);
    await session.release(BACKGROUND_CONTEXT);

    const o = out();
    const code = await runSessionsCommand(
      { command: 'attach', id: session.id, tail: 10 },
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    const text = o.lines.join('\n');
    expect(text).toContain('owned');
    expect(text).not.toContain('\u001b');
  });

  it('names the unfinished durable work a crashed run left behind', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const harness = await Harness.open(
      session.storage,
      { models: fauxModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    // A live task record a dead process would have left: created without
    // enabling scheduling, then the storage is closed under it.
    await harness.commit(async (tx) => {
      await tx.createTask(
        GenerationTask,
        {},
        {
          ownership: { kind: 'conversation' },
          conversationId: conversation.id,
        },
      );
      // A queued input that never reached the transcript either.
      await tx.createSubmission({
        type: 'input',
        conversationId: conversation.id,
        status: 'queued',
      });
    }, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);
    await session.release(BACKGROUND_CONTEXT);

    const o = out();
    const code = await runSessionsCommand(
      { command: 'attach', id: session.id, tail: 0 },
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(o.lines).toContain('pending task: pi.generation (pending)');
    expect(o.lines).toContain('pending submission: input (queued)');
  });

  it('fails cleanly for unknown sessions and unsafe ids', async () => {
    const root = tmpRoot();
    const o = out();
    const e = out();
    expect(
      await runSessionsCommand(
        { command: 'attach', id: 'nope' },
        {
          sessionsRoot: root,
          out: o.write,
          logger: createLineLogger(e.write),
        },
      ),
    ).toBe(1);
    expect(e.lines.join('\n')).toContain('error:');
    expect(o.lines.join('\n')).not.toContain('error:');
    // The id is a path segment: a traversal is refused before any store I/O.
    expect(
      await runSessionsCommand(
        { command: 'attach', id: '../x' },
        {
          sessionsRoot: root,
          out: o.write,
        },
      ),
    ).toBe(2);
  });
});

describe('sessions CLI approvals posture (issue #16, slice D)', () => {
  it('records full-access on create with the flag and indicates on attach', async () => {
    const root = tmpRoot();
    const o = out();
    const created = await runSessionsCommand(
      { command: 'create', cwd: '/work', dangerouslySkipApprovals: true },
      { sessionsRoot: root, out: o.write },
    );
    expect(created).toBe(0);
    expect(o.lines.some((line) => line.includes('full-access'))).toBe(true);
    const id = o.lines[0] ?? '';
    const o2 = out();
    const attached = await runSessionsCommand(
      { command: 'attach', id: id, tail: 0 },
      {
        sessionsRoot: root,
        out: o2.write,
      },
    );
    expect(attached).toBe(0);
    expect(o2.lines.some((line) => line.includes('posture: full-access'))).toBe(
      true,
    );
  });

  it('defaults to approvals enforced and rejects bad ids', async () => {
    const root = tmpRoot();
    const o = out();
    expect(
      await runSessionsCommand(
        { command: 'create', cwd: '/work' },
        {
          sessionsRoot: root,
          out: o.write,
        },
      ),
    ).toBe(0);
    const id = o.lines[0] ?? '';
    const o2 = out();
    expect(
      await runSessionsCommand(
        { command: 'attach', id: id, tail: 0 },
        {
          sessionsRoot: root,
          out: o2.write,
        },
      ),
    ).toBe(0);
    expect(
      o2.lines.some((line) => line.includes('posture: approvals enforced')),
    ).toBe(true);
    const o3 = out();
    expect(
      await runSessionsCommand(
        { command: 'attach', id: '../../etc', tail: 0 },
        {
          sessionsRoot: root,
          out: o3.write,
        },
      ),
    ).toBe(2);
    expect(o3.lines.some((line) => line.includes('invalid session id'))).toBe(
      true,
    );
  });
});

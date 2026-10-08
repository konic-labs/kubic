// `kubic sessions` CLI (for the attach transcript).
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
  AssistantEntry,
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
import { auditLedgerDirFor, readAuditLedger } from './policy/audit-ledger.js';
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
    session.adopt(),
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

// One real session with a faux turn AND a real compaction, released for the
// CLI to attach (the compaction entry must render readable).
async function seededCompactedSession(root: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: '/work' },
    BACKGROUND_CONTEXT,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    session.adopt(),
    {
      models,
      registry: createRegistry(),
      // Evict everything, so the compact commits a summary entry.
      settings: { compaction: { keepRecentTokens: 0 } },
    },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  });
  faux.setResponses([fauxAssistantMessage('a long answer')]);
  await (
    await conversation.submit(
      { type: 'input', content: 'work' },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  // The summarizer's answer becomes the stored compaction summary.
  faux.setResponses([fauxAssistantMessage('## Goal\nSummarized.')]);
  const task = await conversation.compact(undefined, BACKGROUND_CONTEXT);
  const settled = await harness.waitForTask(task, BACKGROUND_CONTEXT);
  // The summary is placed through a write submission: wait for that write
  // so the entry is committed when attach reads it.
  const submissionId =
    settled.state.outcome.status === 'completed'
      ? settled.state.outcome.result.submissionId
      : undefined;
  if (submissionId !== undefined) {
    await (await harness.submission(submissionId, BACKGROUND_CONTEXT))?.wait(
      BACKGROUND_CONTEXT,
    );
  }
  await harness.close(BACKGROUND_CONTEXT);
  await session.release(BACKGROUND_CONTEXT);
  return session.id;
}

describe('sessions CLI', () => {
  it('creates and lists sessions', async () => {
    const root = tmpRoot();
    // Create refuses a missing cwd, so the fixture workspace
    // must exist.
    const work = join(root, 'work');
    mkdirSync(work);
    const o = out();
    const created = (
      await runSessionsCommand(
        { command: 'create', cwd: work },
        {
          sessionsRoot: root,
          out: o.write,
        },
      )
    ).exitCode;
    expect(created).toBe(0);
    expect(o.lines.length).toBe(1);
    const id = o.lines[0] ?? '';
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    // A separate sink: the listing itself must carry the session and its cwd.
    const listing = out();
    const listed = (
      await runSessionsCommand(
        { command: 'list' },
        {
          sessionsRoot: root,
          out: listing.write,
        },
      )
    ).exitCode;
    expect(listed).toBe(0);
    expect(
      listing.lines.some((line) => line.includes(id) && line.includes(work)),
    ).toBe(true);
  });

  it('create --cwd resolves a relative path against the invoking directory', async () => {
    const root = tmpRoot();
    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'create', cwd: '.' },
        { sessionsRoot: root, out: o.write },
      )
    ).exitCode;
    expect(code).toBe(0);
    const id = o.lines[0] ?? '';
    const listing = out();
    await runSessionsCommand(
      { command: 'list', json: true },
      { sessionsRoot: root, out: listing.write },
    );
    const entries = JSON.parse(listing.lines.join('\n')) as Array<{
      id: string;
      cwd: string;
    }>;
    // Absolute, and the caller's directory — never the sessions root.
    expect(entries.find((entry) => entry.id === id)?.cwd).toBe(process.cwd());
  });

  it('create --cwd refuses a missing or non-directory path by name', async () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'file'), 'not a directory\n');
    for (const bad of [join(root, 'does-not-exist'), join(root, 'file')]) {
      const o = out();
      const e = out();
      const code = (
        await runSessionsCommand(
          { command: 'create', cwd: bad },
          {
            sessionsRoot: root,
            out: o.write,
            logger: createLineLogger(e.write),
          },
        )
      ).exitCode;
      expect(code).toBe(1);
      expect(e.lines.join('\n')).toContain(bad);
    }
    // Neither refusal created a session.
    const listing = out();
    await runSessionsCommand(
      { command: 'list', json: true },
      { sessionsRoot: root, out: listing.write },
    );
    expect(listing.lines).toEqual(['[]']);
  });

  it('list --json prints [] when there are no sessions', async () => {
    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'list', json: true },
        {
          sessionsRoot: tmpRoot(),
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(o.lines).toEqual(['[]']);
  });

  it('marks a legacy session in the listing as legacy', async () => {
    const root = tmpRoot();
    // The legacy layout: <root>/--<cwd>--/<ts>_<id>.jsonl
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
    const code = (
      await runSessionsCommand(
        { command: 'list' },
        { sessionsRoot: root, out: o.write },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('legacy-1');
    expect(o.lines.join('\n')).toContain('(legacy pi 0.87');
  });

  it('list --json emits one {id, cwd} object per session', async () => {
    const root = tmpRoot();
    const work = join(root, 'work');
    mkdirSync(work);
    const o = out();
    await runSessionsCommand(
      { command: 'create', cwd: work },
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
      { id: o.lines[0], cwd: work },
    ]);
  });

  it('attaches and shows the transcript tail as readable turn lines', async () => {
    const root = tmpRoot();
    const id = await seededSession(root);
    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'attach', id, tail: 5 },
        {
          sessionsRoot: root,
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(o.lines[0]).toBe(`session ${id}  cwd=/work`);
    expect(o.lines).toContain('user: cli hello');
    expect(o.lines).toContain('assistant: cli hello back');
    // No raw truncated JSON entry anywhere on the attach output.
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
    const code = (
      await runSessionsCommand(
        { command: 'attach', id, tail: 10 },
        {
          sessionsRoot: root,
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const assistant = o.lines.find((line) =>
      line.startsWith('assistant: (no text) [tools: read]'),
    );
    expect(assistant).toBeDefined();
    expect(o.lines.some((line) => line.startsWith('tool-result read:'))).toBe(
      true,
    );
  });

  it('renders a compaction entry as a readable line under --tail', async () => {
    const root = tmpRoot();
    const id = await seededCompactedSession(root);
    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'attach', id, tail: 3 },
        {
          sessionsRoot: root,
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(o.lines.some((line) => line.startsWith('[compaction]'))).toBe(true);
    expect(o.lines.join('\n')).toContain('Summarized.');
    expect(o.lines.join('\n')).not.toContain('"role"');
  });

  it('attach --json keeps the raw tail entries', async () => {
    const root = tmpRoot();
    const id = await seededCompactedSession(root);
    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'attach', id, tail: 10, json: true },
        {
          sessionsRoot: root,
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    // Raw entries: every entry line parses as JSON and the compaction
    // entry is present in full (no truncation, no readable rendering).
    const tail = o.lines.filter((line) => line.startsWith('{'));
    expect(tail.length).toBeGreaterThan(0);
    for (const line of tail) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(tail.join('\n')).toContain('pi.compaction');
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
      session.adopt(),
      { models: fauxModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    // A hostile turn: clearing the screen and recolouring the operator's
    // terminal is the payload, in the text AND in the model-authored tool
    // name (pi-durable persists a call the registry never offered).
    await harness.commit(async (tx) => {
      await tx.appendEntry(AssistantEntry, conversation.id, {
        model: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call-evil',
                name: '\u001b[31mevil',
                arguments: {},
              },
            ],
            api: 'faux',
            provider: 'faux',
            model: 'faux-1',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'toolUse',
            timestamp: Date.now(),
          },
        ],
      });
      await tx.appendEntry(ToolResultEntry, conversation.id, {
        data: { diagnostics: [] },
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-evil',
            toolName: '\u001b[2Jbash',
            content: [{ type: 'text', text: '\u001b[2J\u001b[31mowned' }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);
    await session.release(BACKGROUND_CONTEXT);

    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'attach', id: session.id, tail: 10 },
        { sessionsRoot: root, out: o.write },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = o.lines.join('\n');
    expect(text).toContain('owned');
    // The name survives as inert text; the control byte never does.
    expect(text).toContain('evil');
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
      session.adopt(),
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
    const code = (
      await runSessionsCommand(
        { command: 'attach', id: session.id, tail: 0 },
        { sessionsRoot: root, out: o.write },
      )
    ).exitCode;
    expect(code).toBe(0);
    // 's storage-level probe owns the format, so this is the same line
    // the run path prints when it settles the work.
    const pending = o.lines.filter((line) => line.startsWith('pending work:'));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('pi.generation');
    expect(pending[0]).toContain('submission');
  });

  it('fails cleanly for unknown sessions and unsafe ids', async () => {
    const root = tmpRoot();
    const o = out();
    const e = out();
    expect(
      (
        await runSessionsCommand(
          { command: 'attach', id: 'nope' },
          {
            sessionsRoot: root,
            out: o.write,
            logger: createLineLogger(e.write),
          },
        )
      ).exitCode,
    ).toBe(1);
    expect(e.lines.join('\n')).toContain('error:');
    expect(o.lines.join('\n')).not.toContain('error:');
    // The id is a path segment: a traversal is refused before any store I/O.
    expect(
      (
        await runSessionsCommand(
          { command: 'attach', id: '../x' },
          {
            sessionsRoot: root,
            out: o.write,
          },
        )
      ).exitCode,
    ).toBe(2);
  });
});

describe('sessions CLI approvals posture', () => {
  it('records full-access on create with the flag and indicates on attach', async () => {
    const root = tmpRoot();
    const o = out();
    const created = (
      await runSessionsCommand(
        { command: 'create', cwd: root, dangerouslySkipApprovals: true },
        { sessionsRoot: root, out: o.write },
      )
    ).exitCode;
    expect(created).toBe(0);
    expect(o.lines.some((line) => line.includes('full-access'))).toBe(true);
    const id = o.lines[0] ?? '';
    const o2 = out();
    const attached = (
      await runSessionsCommand(
        { command: 'attach', id: id, tail: 0 },
        {
          sessionsRoot: root,
          out: o2.write,
        },
      )
    ).exitCode;
    expect(attached).toBe(0);
    expect(o2.lines.some((line) => line.includes('posture: full-access'))).toBe(
      true,
    );
  });

  it('appends exactly one full-access ledger row on create with the flag', async () => {
    const root = tmpRoot();
    const ws = tmpRoot();
    const o = out();
    const code = (
      await runSessionsCommand(
        { command: 'create', cwd: ws, dangerouslySkipApprovals: true },
        { sessionsRoot: root, out: o.write },
      )
    ).exitCode;
    expect(code).toBe(0);
    const rows = readAuditLedger(auditLedgerDirFor(ws));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.what).toBe('posture:full-access');
    expect(rows[0]?.posture).toBe('full-access');
  });

  it('defaults to approvals enforced and rejects bad ids', async () => {
    const root = tmpRoot();
    const o = out();
    expect(
      (
        await runSessionsCommand(
          { command: 'create', cwd: root },
          {
            sessionsRoot: root,
            out: o.write,
          },
        )
      ).exitCode,
    ).toBe(0);
    const id = o.lines[0] ?? '';
    const o2 = out();
    expect(
      (
        await runSessionsCommand(
          { command: 'attach', id: id, tail: 0 },
          {
            sessionsRoot: root,
            out: o2.write,
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(
      o2.lines.some((line) => line.includes('posture: approvals enforced')),
    ).toBe(true);
    const o3 = out();
    expect(
      (
        await runSessionsCommand(
          { command: 'attach', id: '../../etc', tail: 0 },
          {
            sessionsRoot: root,
            out: o3.write,
          },
        )
      ).exitCode,
    ).toBe(2);
    expect(o3.lines.some((line) => line.includes('invalid session id'))).toBe(
      true,
    );
  });
});

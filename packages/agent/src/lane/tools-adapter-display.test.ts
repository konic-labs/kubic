// Kubic operations as pi-durable tools.
// The model is told the truth about its tools: every tool carries its real
// parameter schema (not a loose record), declares json_schema constrained
// sampling with strict 'prefer', and read/bash/grep results come back as
// plain text with a short header — raw file lines, never JSON-escaped.
// Unit level: the registry schemas, the replay mapping, the rendered result
// text, the running-output stream and the memo path as the adapter drives
// them through a ToolExecutionApi double. The durable end-to-end behaviour
// (journal under the pi-durable callId, interrupted replay across a restart,
// Kubic's own truncation surviving the harness bound) is pinned by
// tools-adapter-durable.test.ts, which runs the real harness.
import { Buffer } from 'node:buffer';
import { rmSync } from 'node:fs';
import type { FileJournalStore } from '@kubic/exec/journal';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterAll, describe, expect, it } from 'vitest';
import { GREP_MAX_LINE_LENGTH } from '../ops/grep.js';
import type { JsonValue } from '../ops/types.js';
import {
  BACKGROUND_CONTEXT,
  type ToolExecutionApi,
  type ToolRegistration,
} from '../pi-boundary.js';
import { OperationKillRegistry } from './abort.js';
import {
  type KubicToolContext,
  kubicToolsToPiTools,
  renderGrepText,
} from './tools-adapter.js';

// Only the members the adapter reads are real: the call identity, the
// running-output sink and the durable memo (first-writer-wins, like
// pi-durable's task record). Everything else is a cast-away placeholder —
// the real api is exercised by tools-adapter-durable.test.ts.
interface ApiDrive {
  api: ToolExecutionApi;
  output: string[];
  memos: Map<string, JsonValue>;
}

function drive(
  options: { callId?: string; taskId?: number; conversationId?: number } = {},
): ApiDrive {
  const output: string[] = [];
  const memos = new Map<string, JsonValue>();
  const api = {
    taskId: options.taskId ?? 42,
    conversationId: options.conversationId ?? 7,
    callId: options.callId ?? 'call-1',
    output: (chunk: string | Uint8Array) => {
      output.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
    },
    diagnostic: () => undefined,
    details: async () => undefined,
    agent: async () => undefined,
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
    watchDoc: async () => undefined,
    commit: async () => undefined,
    createTask: async () => 1,
    getTask: async () => undefined,
    waitForTask: async () => undefined,
    conversation: async () => undefined,
    // Overload-shaped like ToolExecutionApi.memo: `(name, context)` reads,
    // `(name, candidate, context)` stores first-writer-wins.
    memo: async (name: string, ...rest: readonly unknown[]) => {
      if (rest.length === 1) return memos.get(name);
      const candidate = rest[0] as JsonValue;
      const existing = memos.get(name);
      if (existing !== undefined) return existing;
      memos.set(name, candidate);
      return candidate;
    },
  };
  return { api: api as unknown as ToolExecutionApi, output, memos };
}

function toolContext(
  options: {
    env?: FakeExecutionEnv;
    journal?: FileJournalStore;
    kills?: OperationKillRegistry;
  } = {},
): KubicToolContext {
  return {
    env: options.env ?? new FakeExecutionEnv({}),
    sessionId: 's1',
    agentId: 'root',
    kills: options.kills ?? new OperationKillRegistry(),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  };
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tool(
  name: string,
  context: KubicToolContext = toolContext(),
): ToolRegistration {
  const found = kubicToolsToPiTools(context).find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

async function run(
  name: string,
  params: Record<string, unknown>,
  context: KubicToolContext = toolContext(),
  api: ApiDrive = drive(),
): Promise<{
  text: string;
  isError: boolean | undefined;
  details: unknown;
  api: ApiDrive;
}> {
  const result = await tool(name, context).execute(
    params as never,
    api.api,
    BACKGROUND_CONTEXT,
  );
  const first = result.output?.[0];
  return {
    text: first?.type === 'text' ? first.text : '',
    isError: result.isError,
    details: result.details,
    api,
  };
}

describe('renderGrepText', () => {
  const match = { path: 'a.ts', line: 3, text: 'x' };

  it('appends the notice after the truncated marker', () => {
    expect(
      renderGrepText({
        pattern: 'p',
        matches: [match],
        truncated: true,
        notice: 'why it stopped',
      }),
    ).toBe(
      '[grep /p/: 1 match, truncated (narrow pattern, root or include): why it stopped]\na.ts:3: x\n',
    );
  });

  it('keeps the bare truncated marker when no notice came with it', () => {
    expect(renderGrepText({ pattern: 'p', matches: [], truncated: true })).toBe(
      '[grep /p/: 0 matches, truncated (narrow pattern, root or include)]\n',
    );
  });

  it('says nothing about caps for a complete result', () => {
    expect(
      renderGrepText({ pattern: 'p', matches: [match], truncated: false }),
    ).toBe('[grep /p/: 1 match]\na.ts:3: x\n');
  });

  it('names clipped lines and skipped files', () => {
    // A clipped line read as a whole one is a wrong answer, and a skipped
    // file is a place the pattern was never looked for.
    expect(
      renderGrepText({
        pattern: 'p',
        matches: [match],
        truncated: false,
        linesTruncated: true,
      }),
    ).toBe(
      `[grep /p/: 1 match, lines clipped at ${GREP_MAX_LINE_LENGTH} chars]\na.ts:3: x\n`,
    );
    expect(
      renderGrepText({
        pattern: 'p',
        matches: [],
        truncated: true,
        skippedBinary: 2,
        skippedOversized: 1,
        notice:
          'skipped 1 file(s) over the 8388608B grep bound; results may be incomplete',
      }),
    ).toBe(
      '[grep /p/: 0 matches, truncated (narrow pattern, root or include), 2 binary file(s) skipped, 1 oversized file(s) skipped: skipped 1 file(s) over the 8388608B grep bound; results may be incomplete]\n',
    );
  });
});

// A file change's display record rides the result details (the
// UI's record); the model-facing text stays the op's own result.
describe('file-change display records', () => {
  it('puts the inline diff of an edit in the details, never in the text', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('cart.js', 'a\nexisting.qty = qty;\nb\n');
    const out = await run(
      'edit',
      { path: 'cart.js', oldText: 'qty = qty', newText: 'qty += qty' },
      toolContext({ env }),
    );
    expect(out.text).not.toContain('display');
    expect(out.details).toMatchObject({
      ok: true,
      display: {
        kind: 'diff',
        text: ' 1 a\n-2 existing.qty = qty;\n+2 existing.qty += qty;\n 3 b',
        firstChangedLine: 2,
        added: 1,
        removed: 1,
        truncated: false,
      },
    });
  });

  it('describes a new file, and diffs an overwritten one', async () => {
    const env = new FakeExecutionEnv({});
    const created = await run(
      'write',
      { path: 'notes.md', content: 'one\ntwo\n' },
      toolContext({ env }),
    );
    expect(created.details).toMatchObject({
      display: { kind: 'write', newFile: true, lines: 2, preview: 'one\ntwo' },
    });
    const replaced = await run(
      'write',
      { path: 'notes.md', content: 'one\nthree\n' },
      toolContext({ env }),
    );
    expect(replaced.details).toMatchObject({
      display: { kind: 'diff', added: 1, removed: 1 },
    });
  });
});

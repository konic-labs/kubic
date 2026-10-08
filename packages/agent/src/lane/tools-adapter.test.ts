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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FakeExecutionEnv,
  type ProcessHandle,
  type ProcessSnapshot,
  type ShellResult,
  type SpawnOptions,
} from '../../../exec/src/env.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import { GREP_MAX_LINE_LENGTH } from '../ops/grep.js';
import { OPERATION_PARAMETERS, OPERATIONS } from '../ops/registry.js';
import type { JsonValue } from '../ops/types.js';
import { WALK_MAX_DEPTH, WALK_MAX_ENTRIES } from '../ops/walk.js';
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

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

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
  const first = result.content?.[0];
  return {
    text: first?.type === 'text' ? first.text : '',
    isError: result.isError,
    details: result.details,
    api,
  };
}

async function text(
  name: string,
  params: Record<string, unknown>,
  context: KubicToolContext = toolContext(),
  api: ApiDrive = drive(),
): Promise<string> {
  return (await run(name, params, context, api)).text;
}

// A shell the test scripts: the command reports what `updates` says, settles
// with `result` either immediately or when the test kills it (the abort and
// timeout path), and records every spawn.
function shellEnv(options: {
  updates?: readonly ProcessSnapshot[];
  result?: ShellResult;
  settle?: 'immediate' | 'on-kill';
}): {
  env: FakeExecutionEnv;
  spawns: string[];
} {
  const base = new FakeExecutionEnv({});
  const spawns: string[] = [];
  let resolveWait: ((result: ShellResult) => void) | undefined;
  const result = options.result ?? {
    exitCode: 0,
    stdout: '',
    stderr: '',
    provenance: base.provenance,
  };
  const spawn = (
    cmd: string,
    args: string[],
    opts: SpawnOptions,
  ): ProcessHandle => {
    spawns.push(`${cmd} ${args.join(' ')}`);
    for (const snapshot of options.updates ?? []) {
      opts.onUpdate?.(snapshot, undefined);
    }
    return {
      pid: spawns.length,
      wait: () =>
        new Promise<ShellResult>((resolve) => {
          if (options.settle === 'on-kill') resolveWait = resolve;
          else resolve(result);
        }),
      kill: () => resolveWait?.(result),
    };
  };
  const env = Object.assign(Object.create(base) as FakeExecutionEnv, {
    shell: { spawn },
  });
  return { env, spawns };
}

describe('kubicToolsToPiTools', () => {
  const tools = kubicToolsToPiTools(toolContext());

  it('emits every operation with its registry schema, never a loose record', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      Object.keys(OPERATIONS).sort(),
    );
    for (const t of tools) {
      const schema = t.parameters as {
        type?: string;
        additionalProperties?: unknown;
        patternProperties?: unknown;
      };
      expect(t.parameters, t.name).toBe(
        OPERATION_PARAMETERS[t.name as keyof typeof OPERATION_PARAMETERS],
      );
      expect(schema.type, t.name).toBe('object');
      expect(schema.additionalProperties, t.name).toBe(false);
      expect(schema.patternProperties, t.name).toBeUndefined();
    }
  });

  it.each(Object.keys(OPERATIONS))('%s: schema snapshot', (name) => {
    expect(JSON.parse(JSON.stringify(tool(name).parameters))).toMatchSnapshot();
  });

  it('declares json_schema constrained sampling with strict prefer on every tool', () => {
    for (const t of tools) {
      expect(t.constrainedSampling, t.name).toEqual({
        type: 'json_schema',
        strict: 'prefer',
      });
    }
  });

  it('carries descriptions that state the limits the model must know', () => {
    const byName = Object.fromEntries(
      tools.map((t) => [t.name, t.description]),
    );
    expect(byName.read).toMatch(/1-indexed/);
    expect(byName.read).toMatch(/2000/);
    expect(byName.bash).toMatch(/seconds/);
    expect(byName.grep).toMatch(/100/);
    expect(byName.edit).toMatch(/oldText/);
  });

  it('bash states its default and maximum timeout and the background-job rule', () => {
    const bash = tools.find((t) => t.name === 'bash')?.description;
    // Literal numbers on purpose: the text must track the shipped limits.
    expect(bash).toContain(
      'timeout is in seconds (default 120, at most 600, unless the operator overrides them with KUBIC_BASH_TIMEOUT / KUBIC_BASH_MAX_TIMEOUT in kubic run or kubic tui)',
    );
    expect(bash).toContain('is killed and the header says "timed out"');
    expect(bash).toContain(
      'Jobs the command backgrounds are killed when it ends unless the operator sets KUBIC_BASH_KEEP_BACKGROUND=1 (the output says which happened)',
    );
  });

  it.each([
    ['find', 'never follows or lists symlinks', "the result's notice names"],
    ['grep', 'never follows symlinks', 'the header names which one'],
  ])(
    '%s states its ignore rules, symlink rule and walk caps',
    (name, symlinks, cap) => {
      const description = tools.find((t) => t.name === name)?.description;
      expect(description).toContain(
        'skips .git, node_modules and paths a .gitignore excludes',
      );
      expect(description).toContain(symlinks);
      expect(description).toContain(
        'at most 10000 entries and 100 directory levels',
      );
      expect(description).toContain(cap);
    },
  );

  it('read returns raw file lines under a short header, not JSON', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'say "hi"\n\tindented\nlast\n');
    const out = await text('read', { path: 'a.txt' }, toolContext({ env }));
    expect(out).toBe(
      '[read a.txt: lines 1-3 of 3]\nsay "hi"\n\tindented\nlast\n',
    );
    expect(out).not.toContain('\\n');
    expect(out).not.toContain('\\"');
  });

  it('read names a truncated window and how to continue', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('b.txt', 'one\ntwo\nthree\nfour\n');
    const out = await text(
      'read',
      { path: 'b.txt', offset: 2, limit: 2 },
      toolContext({ env }),
    );
    expect(out).toBe(
      '[read b.txt: lines 2-3 of 4; more: offset=4]\ntwo\nthree\n',
    );
  });

  it('read names an empty window', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('e.txt', '');
    expect(await text('read', { path: 'e.txt' }, toolContext({ env }))).toBe(
      '[read e.txt: empty (0 lines)]\n',
    );
  });

  it('read names an offset past the last line', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('t.txt', 'a\nb\nc\n');
    expect(
      await text('read', { path: 't.txt', offset: 5 }, toolContext({ env })),
    ).toBe('[read t.txt: offset 5 is past the last line (3 lines total)]\n');
  });

  it('read names a line that alone exceeds the output cap', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('min.js', 'x'.repeat(3 * 1024 * 1024));
    expect(await text('read', { path: 'min.js' }, toolContext({ env }))).toBe(
      "[read min.js: line 1 is 3145728B — above the 51200B output cap; read it with bash: sed -n '1p' < 'min.js' | head -c 51200]\n",
    );
  });

  it('read names a byte-clipped window and points at the next offset', async () => {
    const env = new FakeExecutionEnv({});
    const line = (n: number) =>
      `${String(n).padStart(5, '0')} ${'y'.repeat(93)}`;
    env.fs.writeFile(
      'wide.txt',
      `${Array.from({ length: 1000 }, (_, i) => line(i + 1)).join('\n')}\n`,
    );
    const out = await text('read', { path: 'wide.txt' }, toolContext({ env }));
    expect(out.split('\n')[0]).toBe(
      '[read wide.txt: lines 1-512 of at least 1000; more: offset=513; output clipped at 51200B]',
    );
    expect(out.split('\n')[1]).toBe(line(1));
    expect(out.split('\n')[512]).toBe(line(512));
    expect(out).not.toContain(line(513));
  });

  it('read refuses binary content with size and type, never replacement chars', async () => {
    const env = new FakeExecutionEnv({});
    // Seam without ranged reads: the literal-U+FFFD fixture
    // only refuses on the fallback path, which treats a surviving U+FFFD
    // as evidence the decode replaced bytes (fail-closed by design).
    env.fs.readFileRange = undefined;
    env.fs.writeFile('logo.png', '\uFFFDPNG\r\n\u001a\n');
    const out = await text('read', { path: 'logo.png' }, toolContext({ env }));
    // BYTE size: U+FFFD is 3 bytes in UTF-8, so the 8-char
    // fixture stats as 10 bytes.
    expect(out).toBe(
      `[read logo.png: binary file (10B, invalid UTF-8) — read serves text only; use bash for byte-level inspection]\n`,
    );
    expect(out).not.toContain('\uFFFD');
  });

  it('grep returns path:line: text lines under a header', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('src/a.ts', 'const a = "x"; // TODO\nok\n');
    const out = await text('grep', { pattern: 'TODO' }, toolContext({ env }));
    expect(out).toBe(
      '[grep /TODO/: 1 match]\nsrc/a.ts:1: const a = "x"; // TODO\n',
    );
  });

  it('grep says so when nothing matched', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'nothing\n');
    expect(await text('grep', { pattern: 'zzz' }, toolContext({ env }))).toBe(
      '[grep /zzz/: 0 matches]\n',
    );
  });

  it('grep names the walk entry cap and the directory that exhausted it', async () => {
    const env = new FakeExecutionEnv({});
    for (let i = 0; i < WALK_MAX_ENTRIES + 10; i += 1) {
      env.fs.writeFile(`zzz/f${i}.txt`, 'nothing\n');
    }
    expect(
      await text('grep', { pattern: 'needle' }, toolContext({ env })),
    ).toBe(
      `[grep /needle/: 0 matches, truncated (narrow pattern, root or include): walk entry cap ${WALK_MAX_ENTRIES} reached while listing zzz; results may be incomplete]\n`,
    );
  });

  it('grep names the depth cap and where the walk was pruned', async () => {
    const env = new FakeExecutionEnv({});
    const deep = Array.from({ length: WALK_MAX_DEPTH + 2 }, () => 'd').join(
      '/',
    );
    env.fs.writeFile(`${deep}/x.txt`, 'needle\n');
    const out = await text('grep', { pattern: 'needle' }, toolContext({ env }));
    expect(out).toBe(
      `[grep /needle/: 0 matches, truncated (narrow pattern, root or include): walk depth cap ${WALK_MAX_DEPTH} reached at ${Array.from({ length: WALK_MAX_DEPTH + 1 }, () => 'd').join('/')}; results may be incomplete]\n`,
    );
  });

  it('grep names maxMatches as the limit when the match cap stopped the search', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'hit 1\nhit 2\nhit 3\n');
    expect(
      await text(
        'grep',
        { pattern: 'hit', maxMatches: 2 },
        toolContext({ env }),
      ),
    ).toBe(
      '[grep /hit/: 2 matches, truncated (narrow pattern, root or include): result cap 2 reached (maxMatches); results may be incomplete]\na.txt:1: hit 1\na.txt:2: hit 2\n',
    );
  });

  it('find carries the same cap notices in its JSON result', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'x');
    env.fs.writeFile('b.txt', 'x');
    const out = JSON.parse(
      await text('find', { maxResults: 1 }, toolContext({ env })),
    ) as { truncated: boolean; notice?: string };
    expect(out.truncated).toBe(true);
    expect(out.notice).toBe(
      'result cap 1 reached (maxResults); results may be incomplete',
    );
  });

  it('bash returns raw stdout/stderr under an exit header', async () => {
    const base = new FakeExecutionEnv({});
    const env = Object.assign(Object.create(base) as FakeExecutionEnv, {
      shell: {
        spawn: (): ProcessHandle => ({
          pid: 1,
          wait: async () => ({
            exitCode: 2,
            stdout: 'line "one"\nline two\n',
            stderr: 'warn\n',
            provenance: base.provenance,
          }),
          kill: () => undefined,
        }),
      },
    });
    const out = await text('bash', { command: 'x' }, toolContext({ env }));
    expect(out).toMatch(/^\[bash exit 2 \((bash|sh|cmd)\)\]\n/);
    expect(out).toContain('--- stdout ---\nline "one"\nline two\n');
    expect(out).toContain('--- stderr ---\nwarn\n');
    expect(out).not.toContain('\\n');
  });

  it('other tools keep their structured JSON result', async () => {
    const env = new FakeExecutionEnv({});
    const out = await text(
      'write',
      { path: 'w.txt', content: 'x' },
      toolContext({ env }),
    );
    expect(JSON.parse(out)).toMatchObject({ path: 'w.txt' });
  });

  it('an unexpected throw stays an internal error result and never rejects', async () => {
    // readFailure names known fs failures and propagates anything else
    // unchanged, so a raw seam fault reaches callOperation's catch and
    // becomes code 'internal' content — the promise resolves, pi-durable
    // only marks a throw as an error result.
    const base = new FakeExecutionEnv({});
    const fault = (): never => {
      throw new Error('disk on fire');
    };
    const env = Object.assign(Object.create(base) as FakeExecutionEnv, {
      fs: { ...base.fs, readFile: fault, readFileRange: fault },
    });
    const out = await run('read', { path: 'x.txt' }, toolContext({ env }));
    expect(out.text).toBe('error internal: disk on fire');
    expect(out.isError).toBeUndefined();
    expect(out.details).toEqual({
      ok: false,
      toolCallId: 'call-1',
      code: 'internal',
    });
  });

  it('a failed never-replay op writes no memo on the lane either', async () => {
    // The lane sets keepEffectMemo: false, so the registry memo never
    // engages there — success (above) or failure, no second durable copy.
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('x.txt', 'aaa\n');
    const api = drive({ callId: 'call-edit-1' });
    const out = await run(
      'edit',
      { path: 'x.txt', oldText: 'zzz-no-match', newText: 'b' },
      toolContext({ env }),
      api,
    );
    expect(out.text).toBe('error no_match: edit: oldText not found in x.txt');
    expect(out.details).toEqual({
      ok: false,
      toolCallId: 'call-edit-1',
      code: 'no_match',
    });
    expect([...api.memos.keys()]).toEqual([]);
  });

  it('an op error stays a model-readable error line', async () => {
    const out = await run('read', { path: 'missing.txt' });
    expect(out.text).toBe('error not_found: read: no such file: missing.txt');
    // A structured refusal is content, not a fault: pi-durable only marks a
    // throw as an error result.
    expect(out.isError).toBeUndefined();
    expect(out.details).toEqual({
      ok: false,
      toolCallId: 'call-1',
      code: 'not_found',
    });
  });
});

describe('kubicToolsToPiTools on the pi-durable surface', () => {
  it('names the call in the result details', async () => {
    const out = await run(
      'read',
      { path: 'missing.txt' },
      toolContext(),
      drive({ callId: 'call-9' }),
    );
    expect(out.details).toEqual({
      ok: false,
      toolCallId: 'call-9',
      code: 'not_found',
    });
    const ok = await run('write', { path: 'w.txt', content: 'x' });
    expect(ok.details).toEqual({
      ok: true,
      toolCallId: 'call-1',
      invocationId: 'call-1',
      // A new file's display record rides along.
      display: { kind: 'write', newFile: true, lines: 1, preview: 'x' },
    });
  });

  // Kubic's `never`/`safe` maps onto pi-durable's `unsafe`/`safe`, so
  // an interrupted effect is never rerun. Pinned per op: flipping one is a
  // crash-safety change, not a detail.
  it('maps every op replay flag onto the pi-durable vocabulary', () => {
    const tools = kubicToolsToPiTools(toolContext());
    const expected = Object.fromEntries(
      Object.entries(OPERATIONS).map(([name, op]) => [
        name,
        op.replay === 'never' ? 'unsafe' : 'safe',
      ]),
    );
    expect(expected).toMatchObject({
      write: 'unsafe',
      edit: 'unsafe',
      bash: 'unsafe',
      git_stage: 'unsafe',
      git_commit: 'unsafe',
      git_checkpoint: 'unsafe',
      git_branch: 'unsafe',
      read: 'safe',
      grep: 'safe',
      find: 'safe',
      ls: 'safe',
      git_status: 'safe',
    });
    for (const t of tools) {
      expect(t.replay, t.name).toBe(expected[t.name]);
    }
  });

  it('sets an output backstop far above every Kubic cap', () => {
    const tools = kubicToolsToPiTools(toolContext());
    for (const t of tools) {
      // bash streams, so its retained window is the interrupted path's
      // content and is bounded like the cap instead (see the next
      // test); every other tool only reports its bounded result.
      expect(t.outputLimits, t.name).toEqual(
        t.name === 'bash'
          ? { maxBytes: 4 * 64 * 1024, maxLines: 100_000, retain: 'tail' }
          : { maxBytes: 8 * 1024 * 1024, maxLines: 100_000, retain: 'head' },
      );
    }
  });

  // On the interrupted path: pi-durable hands the model the retained
  // live output (renderBashText never runs), so the window must be the same
  // order of magnitude as a capped bash result, and the tail is what
  // `clip()` keeps.
  it('bounds the streamed window of a bash call to the op cap, tail retained', () => {
    const bash = tool('bash');
    const limits = bash.outputLimits as {
      maxBytes: number;
      maxLines: number;
      retain: string;
    };
    expect(limits.retain).toBe('tail');
    // Two capped streams plus their markers stay well inside the window, so
    // the retention can never trim a completed call's content.
    expect(limits.maxBytes).toBeGreaterThanOrEqual(2 * 64 * 1024 + 4096);
    expect(limits.maxBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('journal interception is attributed to the pi-durable call id', async () => {
    const env = new FakeExecutionEnv({});
    const journal = new FileJournalStore(scratch('kubic-adapter-j-'));
    const context = toolContext({ env, journal });
    await text(
      'write',
      { path: 'n.txt', content: 'hi\n' },
      context,
      drive({ callId: 'call-write-1' }),
    );
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('create');
    expect(entries[0]?.toolCallId).toBe('call-write-1');
    expect(env.fs.readFile('n.txt')).toBe('hi\n');
  });

  it('streams running bash output through api.output, deltas only', async () => {
    const first: ProcessSnapshot = {
      stdout: 'one\n',
      stderr: '',
      exitCode: null,
    };
    const second: ProcessSnapshot = {
      stdout: 'one\ntwo\n',
      stderr: 'warn\n',
      exitCode: null,
    };
    const shell = shellEnv({
      updates: [first, second],
      result: {
        exitCode: 0,
        stdout: 'one\ntwo\n',
        stderr: 'warn\n',
        provenance: new FakeExecutionEnv({}).provenance,
      },
    });
    const api = drive();
    const out = await run(
      'bash',
      { command: 'x' },
      toolContext({ env: shell.env }),
      api,
    );
    expect(api.output).toEqual([
      '--- stdout ---\none\n',
      'two\n',
      '--- stderr ---\nwarn\n',
    ]);
    // The streamed text is the live view; the model-visible result is the
    // rendered snapshot, unchanged.
    expect(out.text).toBe(
      '[bash exit 0 (bash)]\n--- stdout ---\none\ntwo\n--- stderr ---\nwarn\n',
    );
  });

  it('restarts the live view from what the seam still holds after a trimmed stream', async () => {
    // env.ts keeps the tail once its 10 MiB per-stream cap trips: the
    // retained text is not an extension of what was streamed.
    const shell = shellEnv({
      updates: [
        { stdout: 'head-tail', stderr: '', exitCode: null },
        { stdout: 'tail', stderr: '', exitCode: null },
      ],
      result: {
        exitCode: 0,
        stdout: 'tail',
        stderr: '',
        provenance: new FakeExecutionEnv({}).provenance,
      },
    });
    const api = drive();
    await run('bash', { command: 'x' }, toolContext({ env: shell.env }), api);
    expect(api.output).toEqual(['--- stdout ---\nhead-tail', 'tail']);
  });

  it('does not copy a never-replay result into a memo on the lane', async () => {
    const shell = shellEnv({
      result: {
        exitCode: 0,
        stdout: 'hi\n',
        stderr: '',
        provenance: new FakeExecutionEnv({}).provenance,
      },
    });
    const context = toolContext({ env: shell.env });
    const api = drive({ callId: 'call-bash-1' });
    const first = await run('bash', { command: 'echo hi' }, context, api);
    expect(shell.spawns).toHaveLength(1);
    // pi-durable's `unsafe` replay policy already refuses to re-enter
    // execute, so the registry's effect memo could never be read: the lane
    // writes no second durable copy of a result that can be a fully capped
    // bash transcript. A replayed invocation therefore executes again and
    // gets the same answer from the op itself.
    expect([...api.memos.keys()]).toEqual([]);
    const second = await run('bash', { command: 'echo hi' }, context, api);
    expect(shell.spawns).toHaveLength(2);
    expect(second.text).toBe(first.text);
  });

  it('registers the call kill handle under the conversation id', async () => {
    // A killed child settles with the shell's signal code, as the real seam
    // reports it (exitCode is a number there, never null).
    const shell = shellEnv({
      settle: 'on-kill',
      result: {
        exitCode: 143,
        stdout: '',
        stderr: '',
        provenance: new FakeExecutionEnv({}).provenance,
      },
    });
    const kills = new OperationKillRegistry();
    const api = drive({ conversationId: 7 });
    const pending = run(
      'bash',
      { command: 'sleep 100' },
      toolContext({ env: shell.env, kills }),
      api,
    );
    // bash hands its handle over before waiting, so a lane abort can drain
    // the tree of the conversation's live run.
    let kill: (() => void) | undefined;
    await vi.waitFor(() => {
      const drained = kills.drain('7');
      expect(drained).toHaveLength(1);
      kill = drained[0];
    });
    kill?.();
    const out = await pending;
    expect(out.text).toBe('[bash exit 143 (bash)]\n(no output)\n');
  });

  it('drops the kill handle once the call settles', async () => {
    const shell = shellEnv({});
    const kills = new OperationKillRegistry();
    const api = drive({ conversationId: 7 });
    for (let i = 0; i < 3; i += 1) {
      const out = await run(
        'bash',
        { command: 'true' },
        toolContext({ env: shell.env, kills }),
        api,
      );
      expect(out.text).toBe('[bash exit 0 (bash)]\n(no output)\n');
    }
    // One registry lives for the whole TUI session: a handle retained per
    // completed call kept that call's output alive for the life of the run.
    expect(kills.drain('7')).toEqual([]);
  });
});

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

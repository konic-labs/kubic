// Kubic operations as Pi tools (issue #168; §37.5, §40.3, §39.1 lever 5).
// The model is told the truth about its tools: every tool carries its real
// parameter schema (not a loose record), declares json_schema constrained
// sampling with strict 'prefer', and read/bash/grep results come back as
// plain text with a short header — raw file lines, never JSON-escaped.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv, type ProcessHandle } from '../../../exec/src/env.js';
import { MemoryMemoStore } from '../ops/memos.js';
import { OPERATION_PARAMETERS, OPERATIONS } from '../ops/registry.js';
import { WALK_MAX_DEPTH, WALK_MAX_ENTRIES } from '../ops/walk.js';
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
} from '../pi-boundary.js';
import { BACKGROUND_CONTEXT } from '../pi-boundary.js';
import { OperationKillRegistry } from './abort.js';
import {
  type KubicToolContext,
  kubicToolsToPiTools,
  renderGrepText,
} from './tools-adapter.js';

function invocation(id = 'inv-1'): AgentHarnessToolInvocation {
  const memos = new Map<string, unknown>();
  return {
    invocationId: id,
    operationId: 'op-1',
    turnId: 't-1',
    getMemo: async (name) => memos.get(name) as never,
    setMemo: async (name, value) => {
      memos.set(name, value);
    },
  };
}

function context(env = new FakeExecutionEnv({})): KubicToolContext {
  return {
    env,
    sessionId: 's1',
    agentId: 'root',
    memos: new MemoryMemoStore(),
    kills: new OperationKillRegistry(),
  };
}

function tool(name: string): AgentHarnessTool<KubicToolContext> {
  const found = kubicToolsToPiTools().find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

async function text(
  name: string,
  params: Record<string, unknown>,
  ctx: KubicToolContext,
): Promise<string> {
  const result = await tool(name).execute(
    'call-1',
    params as never,
    () => undefined,
    ctx,
    invocation(),
    BACKGROUND_CONTEXT,
  );
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('no text content');
  return first.text;
}

describe('kubicToolsToPiTools (issue #168)', () => {
  const tools = kubicToolsToPiTools();

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

  it('bash states its default and maximum timeout and the background-job rule (issue #339)', () => {
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
    '%s states its ignore rules, symlink rule and walk caps (issue #172)',
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
    const out = await text('read', { path: 'a.txt' }, context(env));
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
      context(env),
    );
    expect(out).toBe(
      '[read b.txt: lines 2-3 of 4; more: offset=4]\ntwo\nthree\n',
    );
  });

  it('read names an empty window', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('e.txt', '');
    expect(await text('read', { path: 'e.txt' }, context(env))).toBe(
      '[read e.txt: empty (0 lines)]\n',
    );
  });

  it('read names an offset past the last line', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('t.txt', 'a\nb\nc\n');
    expect(await text('read', { path: 't.txt', offset: 5 }, context(env))).toBe(
      '[read t.txt: offset 5 is past the last line (3 lines total)]\n',
    );
  });

  it('read names a line that alone exceeds the output cap', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('min.js', 'x'.repeat(3 * 1024 * 1024));
    expect(await text('read', { path: 'min.js' }, context(env))).toBe(
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
    const out = await text('read', { path: 'wide.txt' }, context(env));
    expect(out.split('\n')[0]).toBe(
      '[read wide.txt: lines 1-512 of at least 1000; more: offset=513; output clipped at 51200B]',
    );
    expect(out.split('\n')[1]).toBe(line(1));
    expect(out.split('\n')[512]).toBe(line(512));
    expect(out).not.toContain(line(513));
  });

  it('read refuses binary content with size and type, never replacement chars', async () => {
    const env = new FakeExecutionEnv({});
    const bytes = '\uFFFDPNG\r\n\u001a\n';
    env.fs.writeFile('logo.png', bytes);
    const out = await text('read', { path: 'logo.png' }, context(env));
    expect(out).toBe(
      `[read logo.png: binary file (${bytes.length}B, invalid UTF-8) — read serves text only; use bash for byte-level inspection]\n`,
    );
    expect(out).not.toContain('\uFFFD');
  });

  it('grep returns path:line: text lines under a header', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('src/a.ts', 'const a = "x"; // TODO\nok\n');
    const out = await text('grep', { pattern: 'TODO' }, context(env));
    expect(out).toBe(
      '[grep /TODO/: 1 match]\nsrc/a.ts:1: const a = "x"; // TODO\n',
    );
  });

  it('grep says so when nothing matched', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'nothing\n');
    expect(await text('grep', { pattern: 'zzz' }, context(env))).toBe(
      '[grep /zzz/: 0 matches]\n',
    );
  });

  it('grep names the walk entry cap and the directory that exhausted it (issue #172)', async () => {
    const env = new FakeExecutionEnv({});
    for (let i = 0; i < WALK_MAX_ENTRIES + 10; i += 1) {
      env.fs.writeFile(`zzz/f${i}.txt`, 'nothing\n');
    }
    expect(await text('grep', { pattern: 'needle' }, context(env))).toBe(
      `[grep /needle/: 0 matches, truncated (narrow pattern, root or include): walk entry cap ${WALK_MAX_ENTRIES} reached while listing zzz; results may be incomplete]\n`,
    );
  });

  it('grep names the depth cap and where the walk was pruned (issue #172)', async () => {
    const env = new FakeExecutionEnv({});
    const deep = Array.from({ length: WALK_MAX_DEPTH + 2 }, () => 'd').join(
      '/',
    );
    env.fs.writeFile(`${deep}/x.txt`, 'needle\n');
    const out = await text('grep', { pattern: 'needle' }, context(env));
    expect(out).toBe(
      `[grep /needle/: 0 matches, truncated (narrow pattern, root or include): walk depth cap ${WALK_MAX_DEPTH} reached at ${Array.from({ length: WALK_MAX_DEPTH + 1 }, () => 'd').join('/')}; results may be incomplete]\n`,
    );
  });

  it('grep names maxMatches as the limit when the match cap stopped the search (issue #172)', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'hit 1\nhit 2\nhit 3\n');
    expect(
      await text('grep', { pattern: 'hit', maxMatches: 2 }, context(env)),
    ).toBe(
      '[grep /hit/: 2 matches, truncated (narrow pattern, root or include): result cap 2 reached (maxMatches); results may be incomplete]\na.txt:1: hit 1\na.txt:2: hit 2\n',
    );
  });

  it('find carries the same cap notices in its JSON result (issue #172)', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'x');
    env.fs.writeFile('b.txt', 'x');
    const out = JSON.parse(
      await text('find', { maxResults: 1 }, context(env)),
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
    const out = await text('bash', { command: 'x' }, context(env));
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
      context(env),
    );
    expect(JSON.parse(out)).toMatchObject({ path: 'w.txt' });
  });

  it('an op error stays a model-readable error line', async () => {
    const out = await text('read', { path: 'missing.txt' }, context());
    expect(out).toBe('error not_found: read: no such file: missing.txt');
  });
});

describe('renderGrepText (issue #172)', () => {
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
});

// Bash spill files (issue #182; §27.5): a stream clipped for the model's
// context window keeps its tail there and writes the FULL stream to a
// session-scoped spill file, whose path the notice and `BashResult.spillPath`
// name — the dropped head (often the first error) stays recoverable.
//
// RED-first note: the op dropped the head with no file behind it, so
// `spillPath` did not exist and the notice named no path.

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { createSessionSpillSink } from '../spill.js';
import { BASH_RESULT_MAX_CHARS, BASH_RESULT_MAX_LINES } from './bash.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A real workspace + a real session dir with the real session sink. */
function ctx(): OpContext {
  return {
    env: new NodeExecutionEnv(tmp('bash-182-ws-')),
    sessionId: 's1',
    agentId: 'a1',
    spill: createSessionSpillSink(tmp('bash-182-session-')),
  };
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

function writeCommand(script: string): string {
  return `${process.execPath} -e "${script}"`;
}

describe('bash spill files (issue #182)', () => {
  it('spills the full stream and names the path in the notice', async () => {
    const total = 200_000;
    const c = ctx();
    const out = await callOperation(
      'bash',
      {
        command: writeCommand(`process.stdout.write('x'.repeat(${total}))`),
        timeout: 30,
      },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    const spillPath = out.result.spillPath;
    expect(spillPath).toBeDefined();
    expect(statSync(spillPath as string).isFile()).toBe(true);
    // The spill holds the FULL stream, head included.
    expect(readFileSync(spillPath as string, 'utf8')).toBe('x'.repeat(total));
    // The context keeps the tail, under a notice that names the spill.
    expect(out.result.stdout).toMatch(
      new RegExp(
        `^\\[kubic: ${total - BASH_RESULT_MAX_CHARS} leading chars dropped — full output: `,
      ),
    );
    expect(out.result.stdout).toContain(String(spillPath));
    expect(out.result.stdout.length).toBeLessThanOrEqual(
      BASH_RESULT_MAX_CHARS + 200,
    );
  });

  it('bounds a stream by lines as well as chars, spilling all of it', async () => {
    const lines = 3000;
    const c = ctx();
    const out = await callOperation(
      'bash',
      {
        command: writeCommand(
          `for (let i = 0; i < ${lines}; i += 1) console.log('line ' + i)`,
        ),
        timeout: 30,
      },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // ~30K chars: the LINE bound is what bites here.
    expect(out.result.truncated).toBe(true);
    const body = out.result.stdout.slice(out.result.stdout.indexOf('\n') + 1);
    expect(body.startsWith('line 1000\n')).toBe(true);
    expect(body.split('\n').filter((l) => l.startsWith('line ')).length).toBe(
      BASH_RESULT_MAX_LINES,
    );
    // …and the spill still has every line, from the first.
    const spilled = readFileSync(out.result.spillPath as string, 'utf8');
    expect(spilled.split('\n')[0]).toBe('line 0');
    expect(
      spilled.split('\n').filter((l) => l.startsWith('line ')).length,
    ).toBe(lines);
  });

  it('spills each clipped stream to its own file', async () => {
    const c = ctx();
    const out = await callOperation(
      'bash',
      {
        command: writeCommand(
          "process.stdout.write('o'.repeat(200000)); process.stderr.write('e'.repeat(200000))",
        ),
        timeout: 30,
      },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const stdoutPath = out.result.spillPath as string;
    expect(stdoutPath).toContain('stdout');
    expect(readFileSync(stdoutPath, 'utf8')).toBe('o'.repeat(200000));
    const spillDir = stdoutPath.slice(0, stdoutPath.lastIndexOf('/'));
    const stderrSpill = join(
      spillDir,
      readdirSync(spillDir).find((name) => name.includes('stderr')) as string,
    );
    expect(readFileSync(stderrSpill, 'utf8')).toBe('e'.repeat(200000));
    expect(out.result.stderr).toContain(`full output: ${stderrSpill}`);
  });

  it('leaves an unclipped stream alone: no notice, no spill', async () => {
    const out = await callOperation(
      'bash',
      { command: 'echo hi' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(false);
    expect(out.result.spillPath).toBeUndefined();
    expect(out.result.stdout).toBe('hi\n');
  });

  it('names no path when the lane gave no sink, and still clips', async () => {
    const total = 200_000;
    const c = ctx();
    const out = await callOperation(
      'bash',
      {
        command: writeCommand(`process.stdout.write('x'.repeat(${total}))`),
        timeout: 30,
      },
      inv(),
      { ...c, spill: undefined },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.spillPath).toBeUndefined();
    expect(out.result.stdout).toMatch(
      /^\[kubic: \d+ leading chars dropped\]\n/,
    );
  });
});

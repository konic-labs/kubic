// Flag values that start with `--` (issue #127): the escape hatches.
// Faux-only prod path: the composition-root runner (apps/kubic) drives a
// real lane with faux models, zero network — the same black-box posture as
// run-prod-path.test.ts. This file pins the three acceptance escapes:
//   --prompt="--help"            equals form, value verbatim
//   -p -- --json-experiment      end-of-flags, next raw token
//   -p --json                    still the typo error (never weakened)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../worker/src/pi-boundary.js';
import { type HeadlessRunResult, runRunCommand } from './run-cli.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-flag-values-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  // The solo notice is not under test here (solo-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function fauxRun(root: string, reply = 'all done') {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(reply)]);
  return (prompt: string): Promise<HeadlessRunResult> =>
    runHeadlessPrompt(
      prompt,
      {},
      { sessionsRoot: root, models, env: new FakeExecutionEnv({}) },
    );
}

function entryTexts(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const texts: string[] = [];
  for (const entry of entries) {
    const message = (entry as { message?: unknown }).message as {
      content?: unknown;
    };
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const text = (part as { type?: unknown; text?: unknown }).text;
      if (
        (part as { type?: unknown }).type === 'text' &&
        typeof text === 'string'
      )
        texts.push(text);
    }
  }
  return texts;
}

async function transcriptOf(root: string, sessionId: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
    return entryTexts(entries).join('\n');
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

describe('run flag values starting with -- (issue #127)', () => {
  it('boots a lane whose prompt is literally --help via the equals form', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = await runRunCommand(['--prompt=--help'], {
      out: o.write,
      run: fauxRun(root),
    });
    expect(exit).toBe(0);
    // A help request would have printed the usage line and exited 0 without
    // running: the lane must have booted instead.
    expect(o.lines.join('\n')).not.toMatch(/usage: kubic run/);
    const sessionId = (o.lines.join('\n').match(/^session: (.+)$/m) ??
      [])[1] as string;
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await transcriptOf(root, sessionId)).toContain('--help');
  });

  it('takes the next raw token after -- as the prompt (-p -- --json-experiment)', async () => {
    const root = tmpRoot();
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['-p', '--', '--json-experiment'], {
      out: o.write,
      run: async (prompt: string) => {
        seen.prompt = prompt;
        return fauxRun(root)(prompt);
      },
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('--json-experiment');
    const sessionId = (o.lines.join('\n').match(/^session: (.+)$/m) ??
      [])[1] as string;
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await transcriptOf(root, sessionId)).toContain('--json-experiment');
  });

  it('leaves --json unset when the prompt merely starts with --json', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = await runRunCommand(['-p', '--', '--json-experiment'], {
      out: o.write,
      run: fauxRun(root),
    });
    expect(exit).toBe(0);
    // --json would collapse the whole output into one JSON envelope line.
    expect(o.lines[0]).toMatch(/^result: /);
    expect(o.lines.length).toBeGreaterThan(1);
  });

  it('accepts a --json-prefixed prompt through the equals form too', async () => {
    const root = tmpRoot();
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['--prompt=--json-experiment'], {
      out: o.write,
      run: async (prompt: string) => {
        seen.prompt = prompt;
        return fauxRun(root)(prompt);
      },
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('--json-experiment');
    expect(o.lines[0]).toMatch(/^result: /);
  });

  it('still catches the typo: -p --json is a missing value, exit 2', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', '--json'], {
      out: o.write,
      run: async () => {
        called = true;
        return fauxRun(tmpRoot())('x');
      },
    });
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/-p needs a value/);
  });

  it('keeps -p without a value (and no --) an error', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', '--'], {
      out: o.write,
      run: async () => fauxRun(tmpRoot())('x'),
    });
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/-p needs a value/);
  });
});

// Review fix (issue #127): the terminator escape must not weaken the
// missing-value report. Only the starved `-p` that the terminator itself
// answered is skipped; a `-p`/`--prompt` starved AFTER a prompt is already
// set keeps its old line and exit 2. A bare `run -- <x>` is a stray
// operand, never a prompt, and an empty prompt (`--prompt=`, `-p ''`) is
// no prompt. The old inline loop's behaviors, input by input:
//   --prompt ok -p  → exit 2, `error: -p needs a value`
//   -p x -p         → exit 2, `error: -p needs a value`
//   -p x -p --      → exit 2, `error: -p needs a value`
//   -- x            → exit 2 (`--` was the old first-offender token)
//   --prompt=       → exit 2 (`--prompt=` was an unknown flag)
describe('run missing values vs the -- escape (issue #127 review)', () => {
  async function refusal(argv: string[]): Promise<{
    exit: number;
    text: string;
    called: boolean;
  }> {
    const o = out();
    let called = false;
    const exit = await runRunCommand(argv, {
      out: o.write,
      run: async () => {
        called = true;
        return fauxRun(tmpRoot())('x');
      },
    });
    return { exit, text: o.lines.join('\n'), called };
  }

  it('reports a starved duplicate -p after --prompt ok (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['--prompt', 'ok', '-p']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('reports a starved duplicate -p after -p x (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['-p', 'x', '-p']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('reports a starved duplicate -p starved by the terminator (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['-p', 'x', '-p', '--']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses a bare -- operand instead of taking it as the prompt (exit 2)', async () => {
    const { exit, text, called } = await refusal(['--', 'x']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/unknown flag x/);
  });

  it('refuses an empty --prompt= value (exit 2, the missing-value line)', async () => {
    const { exit, text, called } = await refusal(['--prompt=']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses an empty positional -p value too (exit 2)', async () => {
    const { exit, text, called } = await refusal(['-p', '']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('boots a lane for --prompt ok (the long spelling keeps working)', async () => {
    const root = tmpRoot();
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['--prompt', 'ok'], {
      out: o.write,
      run: async (prompt: string) => {
        seen.prompt = prompt;
        return fauxRun(root)(prompt);
      },
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('ok');
  });

  it('answers --help before parsing even after -- (issue #100), never a missing error', async () => {
    // `wantsHelp` matches `--help` anywhere in argv, so `-p -- --help` is
    // the help path (exit 0 + usage), not a missing-value error. The
    // literal-`--help`-prompt path is the equals form (pinned above).
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', '--', '--help'], {
      out: o.write,
      run: async () => {
        called = true;
        return fauxRun(tmpRoot())('x');
      },
    });
    expect(exit).toBe(0);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/^usage: kubic run/);
    expect(o.lines.join('\n')).not.toMatch(/needs a value/);
  });

  // Fix cycle 2 (issue #127): the escape fires only when the terminator
  // directly answers a starved -p/--prompt — the flag itself stands
  // immediately before the `--`, and that starved entry is the last one
  // `missing` records. A starved -p with no terminator is never promoted
  // from a following operand; a terminator that answered some other flag
  // does not rescue it; and the skip covers exactly the one entry the
  // terminator answered, so a starved duplicate ahead of it still reports.
  it('refuses -p --json x: no terminator, the operand is never promoted (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['-p', '--json', 'x']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses -p --json -x: a single-dash operand is not promoted either (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['-p', '--json', '-x']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses --prompt --json x: the long spelling has no promotion either (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['--prompt', '--json', 'x']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses -p --session s x: a starved flag never starves the prompt (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['-p', '--session', 's', 'x']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses -p --json -- x: the terminator answers --json, not the starved -p (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal(['-p', '--json', '--', 'x']);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('reports the first starved -p when the terminator answers only the last (-p --json -p -- x)', async () => {
    const { exit, text, called } = await refusal([
      '-p',
      '--json',
      '-p',
      '--',
      'x',
    ]);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('boots -p -- x: the terminator directly answers the starved -p (prompt x)', async () => {
    const root = tmpRoot();
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['-p', '--', 'x'], {
      out: o.write,
      run: async (prompt: string) => {
        seen.prompt = prompt;
        return fauxRun(root)(prompt);
      },
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('x');
  });

  it('boots -p -- --json with the literal prompt and no JSON envelope', async () => {
    const root = tmpRoot();
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['-p', '--', '--json'], {
      out: o.write,
      run: async (prompt: string) => {
        seen.prompt = prompt;
        return fauxRun(root)(prompt);
      },
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('--json');
    // --json would collapse the output into one envelope line.
    expect(o.lines[0]).toMatch(/^result: /);
  });
});

// Fix cycle 3 (issue #127): the escape's precondition is flag-ness as the
// parser saw it, never argv token text. `parseFlagArgs` records each
// starved entry's own token index (`missingAt`); the escape fires only when
// the LAST starved entry is `--prompt` AND that flag's own token sits
// immediately before the `--`. A `-p` the parser consumed as another value
// flag's VALUE (`--session -p`, `--role -p`) is not a flag occurrence at
// all, so a later `--` cannot answer it:
//   -p --session -p -- x        → exit 2, `error: -p needs a value`
//   -p --role -p -- x           → exit 2, `error: -p needs a value`
//   -p --json --session -p -- x → exit 2, `error: -p needs a value`
//   s -p --session -p --        → exit 2, `error: -p needs a value`
// The index clause itself is load-bearing: without it `--session -p -- x`
// would boot with prompt `x` (the token before `--` is textually `-p`), so
// that refusal is pinned here too.
describe("run terminator escape needs the starved flag's own token (issue #127 fix cycle 3)", () => {
  async function refusal(argv: string[]): Promise<{
    exit: number;
    text: string;
    called: boolean;
  }> {
    const o = out();
    let called = false;
    const exit = await runRunCommand(argv, {
      out: o.write,
      run: async () => {
        called = true;
        return fauxRun(tmpRoot())('x');
      },
    });
    return { exit, text: o.lines.join('\n'), called };
  }

  it("refuses -p --session -p -- x: the second -p is --session's value (exit 2, no lane)", async () => {
    const { exit, text, called } = await refusal([
      '-p',
      '--session',
      '-p',
      '--',
      'x',
    ]);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it("refuses -p --role -p -- x: the second -p is --role's value (exit 2, no lane)", async () => {
    const { exit, text, called } = await refusal([
      '-p',
      '--role',
      '-p',
      '--',
      'x',
    ]);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses -p --json --session -p -- x (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal([
      '-p',
      '--json',
      '--session',
      '-p',
      '--',
      'x',
    ]);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses s -p --session -p --: the starved -p is not the terminator-answered token (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal([
      's',
      '-p',
      '--session',
      '-p',
      '--',
    ]);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/-p needs a value/);
  });

  it('refuses --session -p -- x: no starved flag exists, x is a stray operand (exit 2, no lane)', async () => {
    const { exit, text, called } = await refusal([
      '--session',
      '-p',
      '--',
      'x',
    ]);
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(text).toMatch(/unknown flag x/);
  });
});

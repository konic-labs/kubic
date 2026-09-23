// `kubic workers [--json]` (issue #42; §50, §49.3, §13): live procs
// with age/owner/resources, startup span surfaced, --debug spawn +
// clean-exit lines. Presentation only — rows arrive injected.
import { describe, expect, it } from 'vitest';
import { runWorkersCommand, type WorkersCommandDeps } from './workers-cli.js';

function deps(lines: string[]): WorkersCommandDeps {
  return {
    list: () => [
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 2,
        status: 'running',
        startedAtMs: 90_000,
        owner: 'parent-session',
        resources: { skills: ['review'] },
        pid: 4242,
        startupMs: 40,
      },
    ],
    now: () => 100_000,
    out: (line: string) => lines.push(line),
  };
}

describe('kubic workers (issue #42)', () => {
  it('shows live procs with age/owner/resources', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand([], deps(lines));
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/w-1/);
    expect(text).toMatch(/running/);
    expect(text).toMatch(/10s/);
    expect(text).toMatch(/parent-session/);
    expect(text).toMatch(/review/);
  });

  it('prints --json rows carrying the §13 status and startup span ms', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand(['--json'], deps(lines));
    expect(code).toBe(0);
    const rows = JSON.parse(lines.join('\n')) as Array<{
      status: string;
      startupMs: number;
      generation: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.startupMs).toBe(40);
    expect(rows[0]?.generation).toBe(2);
  });

  it('--debug emits spawn and clean-exit lines per §50', async () => {
    const lines: string[] = [];
    const debug: string[] = [];
    const code = await runWorkersCommand(['--debug'], {
      ...deps(lines),
      debug: (line: string) => debug.push(line),
    });
    expect(code).toBe(0);
    expect(debug.some((l) => l.startsWith('[worker] spawn'))).toBe(true);
    expect(
      debug.some((l) => l.startsWith('[exit] code=0 exited cleanly')),
    ).toBe(true);
  });

  it('rejects unknown flags with usage', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand(['--nope'], deps(lines));
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/usage/);
  });
});

// `kubic workers [--json] [--debug]` (issue #42; §50, §49.3, §13): live
// procs with age/owner/resources, startup span surfaced, --debug spawn +
// clean-exit lines. Presentation only — rows arrive injected, and the
// options arrive already parsed (argv, `--help` and unknown flags are the
// commander program's job: apps/kubic/src/commands/orchestrator.test.ts).
//
// Issue #151 splits the row's one status into the §13 PAIR: the AGENT state
// (what the work did) and the PROCESS phase (spawning | ready | exiting), so
// an exited-but-settling worker reads as `settling [exiting]` instead of
// `crashed`.
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../core/src/cli/theme.js';
import {
  runWorkersCommand,
  type WorkerListRow,
  type WorkersCommandDeps,
} from './workers-cli.js';

const ROW: WorkerListRow = {
  workerId: 'w-1',
  sessionId: 's-1',
  generation: 2,
  status: 'ready',
  agentStatus: 'running',
  startedAtMs: 90_000,
  owner: 'parent-session',
  resources: { skills: ['review'] },
  pid: 4242,
  startupMs: 40,
};

function deps(
  lines: string[],
  rows: WorkerListRow[] = [ROW],
  errs: string[] = [],
): WorkersCommandDeps {
  return {
    list: () => rows,
    now: () => 100_000,
    out: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
  };
}

describe('kubic workers (issue #42)', () => {
  it('shows live procs with age/owner/resources as an aligned table', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand({}, deps(lines));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split('\n')).toEqual([
      'WORKER  AGENT    PROCESS  GEN  AGE  OWNER            PID  STARTUP  RESOURCES',
      'w-1     running  ready      2  10s  parent-session  4242     40ms  skills=review',
    ]);
  });

  it('renders placeholders for a row with no pid, startup span or resources', async () => {
    const lines: string[] = [];
    const bare: WorkerListRow = {
      workerId: 'w-2',
      sessionId: 's-1',
      generation: 1,
      status: 'exiting',
      agentStatus: 'failed',
      signal: 'SIGKILL',
      startedAtMs: 100_000 - 3 * 60 * 60 * 1000,
      owner: 'o',
    };
    await runWorkersCommand({}, deps(lines, [bare]));
    expect(lines[0]?.split('\n')[1]).toBe(
      'w-2     failed  exiting(SIGKILL)    1  3h   o        -        -  -',
    );
    // A row that only knows its process phase (an embedder) still renders.
    await runWorkersCommand(
      {},
      deps(lines, [{ ...bare, agentStatus: undefined, signal: undefined }]),
    );
    expect(lines[1]?.split('\n')[1]).toMatch(/^w-2\s+-\s+exiting\s+1\s/);
  });

  it('colours the status through the theme and boxes the table when fancy', async () => {
    const lines: string[] = [];
    const theme = createCliTheme('16');
    await runWorkersCommand({}, { ...deps(lines), theme, fancy: true });
    const text = lines.join('\n');
    expect(text).toContain('┌');
    expect(text).toContain(theme.success('running'));
  });

  it('prints --json rows carrying the §13 status and startup span ms', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand({ json: true }, deps(lines));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual([
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 2,
        status: 'ready',
        agentStatus: 'running',
        ageMs: 10_000,
        owner: 'parent-session',
        resources: { skills: ['review'] },
        pid: 4242,
        startupMs: 40,
      },
    ]);
    // Two-space indented: the one `formatJson` serializer.
    expect(lines[0]).toContain('[\n  {\n    "workerId": "w-1"');
  });

  it('an empty record prints nothing on stdout (`[]` under --json) and says so on stderr', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    expect(await runWorkersCommand({}, deps(lines, [], errs))).toBe(0);
    expect(lines).toEqual([]);
    expect(errs).toEqual([
      'info: no orchestrator workers recorded in this repo',
    ]);

    const json: string[] = [];
    const jsonErrs: string[] = [];
    expect(
      await runWorkersCommand({ json: true }, deps(json, [], jsonErrs)),
    ).toBe(0);
    expect(json).toEqual(['[]']);
    expect(jsonErrs).toEqual([]);
  });

  it('--debug emits spawn and clean-exit lines per §50', async () => {
    const lines: string[] = [];
    const debug: string[] = [];
    const code = await runWorkersCommand(
      { debug: true },
      {
        ...deps(lines),
        debug: (line: string) => debug.push(line),
      },
    );
    expect(code).toBe(0);
    expect(debug).toEqual([
      '[worker] spawn id=w-1 session=s-1 gen=2 pid=4242 startup=40ms',
      '[exit] code=0 exited cleanly',
    ]);
  });

  it('without --debug the debug channel stays silent', async () => {
    const debug: string[] = [];
    await runWorkersCommand(
      {},
      { ...deps([]), debug: (line: string) => debug.push(line) },
    );
    expect(debug).toEqual([]);
  });
});

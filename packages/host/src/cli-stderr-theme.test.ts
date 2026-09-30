// Diagnostics colour follows stderr, never stdout: every handler builds its
// stderr logger from `errTheme` (the composition root derives it from
// process.stderr), so a TTY stdout with a redirected stderr writes no ANSI
// into the log file, and vice versa.

import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../core/src/cli/theme.js';
import { runCostCommand } from './ops/cost/cost-cli.js';
import { runPerfCommand } from './ops/perf/perf-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { runCleanCommand } from './orchestrator/worktree/clean.js';
import { runAuditCommand } from './policy/audit-cli.js';
import { runPolicyCommand } from './policy/policy-cli.js';
import { runReplayCommand } from './replay/replay.js';
import { runWorkersCommand } from './workers-cli.js';

const COLOUR = createCliTheme('truecolor');
const PLAIN = createCliTheme('none');

type Run = (channels: {
  out: (line: string) => void;
  err: (line: string) => void;
  theme: typeof COLOUR;
  errTheme: typeof COLOUR;
}) => Promise<number>;

const HANDLERS: readonly (readonly [string, Run])[] = [
  [
    'cost',
    (io) => runCostCommand({ session: 'a b' }, { ...io, loadRows: () => [] }),
  ],
  ['perf', (io) => runPerfCommand({}, io)],
  [
    'policy',
    (io) =>
      runPolicyCommand({}, {
        ...io,
        resolvePolicy: () => {
          throw new Error('unreached');
        },
      } as Parameters<typeof runPolicyCommand>[1]),
  ],
  [
    'audit',
    (io) =>
      runAuditCommand(
        { mode: 'bogus' } as Parameters<typeof runAuditCommand>[0],
        {
          ...io,
          loadRecords: () => [],
          loadSecrets: () => [],
        } as Parameters<typeof runAuditCommand>[1],
      ),
  ],
  [
    'replay',
    (io) =>
      runReplayCommand(
        {} as Parameters<typeof runReplayCommand>[0],
        {
          ...io,
        } as Parameters<typeof runReplayCommand>[1],
      ),
  ],
  [
    'orchestrate',
    (io) =>
      runOrchestrateCommand(
        { resume: true } as Parameters<typeof runOrchestrateCommand>[0],
        io as unknown as Parameters<typeof runOrchestrateCommand>[1],
      ),
  ],
  [
    'clean',
    (io) =>
      runCleanCommand(
        { sessionId: 'a b' } as Parameters<typeof runCleanCommand>[0],
        io as unknown as Parameters<typeof runCleanCommand>[1],
      ),
  ],
  ['workers', (io) => runWorkersCommand({}, { ...io, list: () => [] })],
];

describe('stderr diagnostics take their colour from errTheme', () => {
  it.each(HANDLERS)(
    '%s: a colour stdout theme never reaches stderr',
    async (_name, run) => {
      const err: string[] = [];
      await run({
        out: () => {},
        err: (l) => err.push(l),
        theme: COLOUR,
        errTheme: PLAIN,
      });
      expect(err.length).toBeGreaterThan(0);
      for (const line of err) expect(line).toBe(stripVTControlCharacters(line));
    },
  );

  it.each(HANDLERS)(
    '%s: a colour stderr theme colours the diagnostic',
    async (_name, run) => {
      const err: string[] = [];
      await run({
        out: () => {},
        err: (l) => err.push(l),
        theme: PLAIN,
        errTheme: COLOUR,
      });
      expect(err.some((line) => line !== stripVTControlCharacters(line))).toBe(
        true,
      );
    },
  );
});

describe('replay --json envelope', () => {
  it('prints one two-space-indented document', async () => {
    const out: string[] = [];
    await runReplayCommand(
      { json: true } as Parameters<typeof runReplayCommand>[0],
      {
        out: (line: string) => out.push(line),
        err: () => {},
      } as unknown as Parameters<typeof runReplayCommand>[1],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(JSON.stringify(JSON.parse(out[0] ?? ''), null, 2));
  });
});

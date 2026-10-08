// Diagnostics colour follows stderr, never stdout (see the host twin,
// packages/host/src/cli-stderr-theme.test.ts): eval, benchmark and export
// build their stderr logger from `errTheme`.

import { stripVTControlCharacters } from 'node:util';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { createCliTheme } from '@kubic/core/cli/theme';
import { describe, expect, it } from 'vitest';
import { runBenchmarkCommand, runEvalCommand } from './cli.js';
import { runExportCommand } from './export-cli.js';

const COLOUR = createCliTheme('truecolor');
const PLAIN = createCliTheme('none');

type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  theme: typeof COLOUR;
  errTheme: typeof COLOUR;
};

const HANDLERS: readonly (readonly [
  string,
  (io: Io) => Promise<CommandResult>,
])[] = [
  [
    'eval',
    (io) =>
      runEvalCommand(
        { generation: '1' } as unknown as Parameters<typeof runEvalCommand>[0],
        {
          ...io,
        } as unknown as Parameters<typeof runEvalCommand>[1],
      ),
  ],
  [
    'benchmark',
    (io) =>
      runBenchmarkCommand(
        { generation: '1' } as unknown as Parameters<
          typeof runBenchmarkCommand
        >[0],
        {
          ...io,
        } as unknown as Parameters<typeof runBenchmarkCommand>[1],
      ),
  ],
  [
    'export',
    (io) =>
      runExportCommand(
        {} as Parameters<typeof runExportCommand>[0],
        {
          ...io,
          readFile: () => {
            throw new Error('unreached');
          },
        } as unknown as Parameters<typeof runExportCommand>[1],
      ),
  ],
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

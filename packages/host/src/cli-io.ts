// Presentation seams shared by the host command handlers (run, doctor,
// models, config, sessions): the stdout data channel, the leveled
// diagnostics logger (stderr in production), the colour theme and the
// table mode. The composition root (apps/kubic/src/prod-runners.ts) wires
// all of them from the real streams; a handler called without a logger or
// theme (unit tests) gets a colourless logger that writes to `out`, so its
// lines stay capturable in one array.

import { type CliLogger, createLogger } from '../../core/src/cli/logger.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';

export type Diagnostics = Pick<
  CliLogger,
  'error' | 'warn' | 'info' | 'success'
>;

export interface CliIo {
  // stdout: the command's data (report, table, `--json` document).
  readonly out: (line: string) => void;
  // Diagnostics (`error: …`, `warn: …`); stderr in production.
  readonly logger?: Diagnostics;
  readonly theme?: CliTheme;
  // Box-drawn tables (an interactive, coloured stdout).
  readonly fancy?: boolean;
}

const PLAIN = createCliTheme('none');

export function diagnosticsOf(io: CliIo): Diagnostics {
  if (io.logger !== undefined) return io.logger;
  return createLogger({
    write: (chunk) => io.out(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk),
  });
}

export function themeOf(io: CliIo): CliTheme {
  return io.theme ?? PLAIN;
}

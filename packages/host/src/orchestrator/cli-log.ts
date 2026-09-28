// The orchestrator-mode commands (orchestrate, clean, workers) receive
// their stderr channel as a LINE writer (`console.error` in prod, an array
// push in tests); the core logger writes newline-terminated chunks. This
// adapter builds the shared consola logger over such a line channel, so
// every diagnostic keeps the one `<level>: <message>` shape on stderr.

import { type CliLogger, createLogger } from '../../../core/src/cli/logger.js';
import type { CliTheme } from '../../../core/src/cli/theme.js';

export function lineLogger(
  err: (line: string) => void,
  options: { readonly theme?: CliTheme; readonly debug?: boolean } = {},
): CliLogger {
  return createLogger({
    write: (chunk) => err(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  });
}

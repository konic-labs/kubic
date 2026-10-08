// `--json` envelopes are one two-space-indented document (core formatJson),
// like every other command's (docs/cli/commands.md, analysis shared rules).

import { formatJson } from '@kubic/core/cli/output';
import { describe, expect, it } from 'vitest';
import { runExportCommand } from './export-cli.js';

describe('export --json envelope', () => {
  it('prints one indented document', async () => {
    const out: string[] = [];
    const code = (
      await runExportCommand(
        { trajectory: ['nope.json'], json: true } as unknown as Parameters<
          typeof runExportCommand
        >[0],
        {
          out: (line: string) => out.push(line),
          err: () => {},
          readFile: () => {
            throw new Error('ENOENT');
          },
        } as unknown as Parameters<typeof runExportCommand>[1],
      )
    ).exitCode;
    expect(code).not.toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(formatJson(JSON.parse(out[0] ?? '')));
    expect(out[0]).toContain('\n  "ok": false');
  });
});

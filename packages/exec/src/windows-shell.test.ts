// The POSIX bash the bash tool runs through on Windows: KUBIC_BASH, else Git
// Bash, else WSL, else none.
import { describe, expect, it } from 'vitest';
import { windowsBash } from './windows-shell.js';

const present = (paths: string[]) => (path: string) => paths.includes(path);

describe('windowsBash', () => {
  it('takes KUBIC_BASH first', () => {
    expect(
      windowsBash(
        { KUBIC_BASH: 'D:\\tools\\bash.exe' },
        present(['D:\\tools\\bash.exe']),
      ),
    ).toEqual({
      kind: 'D:\\tools\\bash.exe',
      command: 'D:\\tools\\bash.exe',
      prefix: [],
    });
  });

  it('finds Git Bash under Program Files', () => {
    const launcher = windowsBash(
      { ProgramFiles: 'C:/Program Files' },
      present(['C:/Program Files/Git/bin/bash.exe']),
    );
    expect(launcher).toMatchObject({ kind: 'Git Bash', prefix: [] });
  });

  it('falls back to WSL, and finds nothing on a bare machine', () => {
    expect(
      windowsBash(
        { SystemRoot: 'C:/Windows' },
        present(['C:/Windows/System32/wsl.exe']),
      ),
    ).toMatchObject({ kind: 'WSL', prefix: ['--cd', '.', '--', 'bash'] });
    expect(windowsBash({}, () => false)).toBeUndefined();
  });
});

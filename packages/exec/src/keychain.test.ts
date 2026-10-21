// The keychain backends, through a recorded runner: what each command line
// carries (never the key) and what reaches standard input.
import { describe, expect, it } from 'vitest';
import { type KeychainRunResult, osKeychain } from './keychain.js';

interface Call {
  command: string;
  args: readonly string[];
  input?: string;
}

function recorder(answers: KeychainRunResult[] = []) {
  const calls: Call[] = [];
  const run = (command: string, args: readonly string[], input?: string) => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }) });
    return answers.shift() ?? { status: 0, stdout: '' };
  };
  return { calls, run };
}

describe('the macOS keychain', () => {
  it('stores a key through standard input, as hex, never on the command line', () => {
    const { calls, run } = recorder();
    osKeychain('darwin', run).set('ANTHROPIC_API_KEY', 'sk-ant-secret');
    expect(calls).toEqual([
      {
        command: 'security',
        args: ['-i'],
        input: `add-generic-password -U -s kubic -a ANTHROPIC_API_KEY -X ${Buffer.from('sk-ant-secret').toString('hex')}\n`,
      },
    ]);
    expect(JSON.stringify(calls[0]?.args)).not.toContain('sk-ant-secret');
  });

  it('reads a key back, and nothing for a missing one', () => {
    const { calls, run } = recorder([
      { status: 0, stdout: 'sk-ant-secret\n' },
      { status: 44, stdout: '' },
    ]);
    const keychain = osKeychain('darwin', run);
    expect(keychain.get('ANTHROPIC_API_KEY')).toBe('sk-ant-secret');
    expect(keychain.get('OPENAI_API_KEY')).toBeUndefined();
    expect(calls[0]?.args).toEqual([
      'find-generic-password',
      '-s',
      'kubic',
      '-a',
      'ANTHROPIC_API_KEY',
      '-w',
    ]);
  });

  it('refuses a name that is not a variable', () => {
    const { run } = recorder();
    expect(() => osKeychain('darwin', run).get('a b; rm')).toThrow(
      'is not a variable name',
    );
  });
});

describe('the Secret Service', () => {
  it('stores through secret-tool with the key on standard input', () => {
    const { calls, run } = recorder();
    const keychain = osKeychain('linux', run);
    keychain.set('OPENAI_API_KEY', 'sk-openai');
    expect(calls).toEqual([
      {
        command: 'secret-tool',
        args: [
          'store',
          '--label=Kubic OPENAI_API_KEY',
          'service',
          'kubic',
          'account',
          'OPENAI_API_KEY',
        ],
        input: 'sk-openai',
      },
    ]);
  });

  it('says when libsecret is not installed', () => {
    const { run } = recorder([
      { status: null, stdout: '', error: 'spawnSync secret-tool ENOENT' },
    ]);
    expect(osKeychain('linux', run).unavailable()).toContain(
      'secret-tool (libsecret) is not installed',
    );
  });
});

describe('elsewhere', () => {
  it('has no keychain, and says so', () => {
    const keychain = osKeychain('win32', recorder().run);
    expect(keychain.unavailable()).toContain('no keychain support on win32');
    expect(() => keychain.set('A_API_KEY', 'x')).toThrow('no keychain support');
  });
});

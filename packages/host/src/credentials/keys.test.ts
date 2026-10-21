// `kubic keys` and the catalogue reading what it stored: a key set for a
// provider is used with no environment variable, the environment wins over
// it, and no value is ever printed.

import type { Keychain } from '@kubic/exec/keychain';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { assembleModels } from '../models/index.js';
import { keychainKeys, readKeychainIndex } from './keychain-keys.js';
import { runKeysCommand } from './keys-cli.js';

function memoryKeychain(): Keychain & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    name: 'the test keychain',
    unavailable: () => undefined,
    get: (account) => entries.get(account),
    set: (account, secret) => {
      entries.set(account, secret);
    },
    remove: (account) => entries.delete(account),
  };
}

function keysDeps(home: string, keychain: Keychain, secret = 'sk-ant-stored') {
  const out: string[] = [];
  return {
    out,
    deps: {
      out: (line: string) => out.push(line),
      home,
      env: {},
      keychain,
      variableFor: async (provider: string) =>
        provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined,
      readSecret: async () => secret,
    },
  };
}

describe('kubic keys', () => {
  it('stores a provider key under its variable and never prints it', async () => {
    const home = tempDir('keys-home-');
    const keychain = memoryKeychain();
    const { out, deps } = keysDeps(home, keychain);
    const set = await runKeysCommand(
      { action: 'set', target: 'anthropic' },
      deps,
    );
    expect(set.exitCode).toBe(0);
    expect(keychain.entries.get('ANTHROPIC_API_KEY')).toBe('sk-ant-stored');
    expect(readKeychainIndex(home)).toEqual(['ANTHROPIC_API_KEY']);
    await runKeysCommand({ action: 'list' }, deps);
    expect(out.join('\n')).not.toContain('sk-ant-stored');
    expect(out.join('\n')).toContain(
      'ANTHROPIC_API_KEY  from the test keychain',
    );
    const removed = await runKeysCommand(
      { action: 'remove', target: 'ANTHROPIC_API_KEY' },
      deps,
    );
    expect(removed.exitCode).toBe(0);
    expect(keychain.entries.size).toBe(0);
    expect(readKeychainIndex(home)).toEqual([]);
  });

  it('refuses a provider whose variable it does not know', async () => {
    const { out, deps } = keysDeps(tempDir('keys-home-'), memoryKeychain());
    const result = await runKeysCommand(
      { action: 'set', target: 'my-gateway' },
      deps,
    );
    expect(result.exitCode).toBe(2);
    expect(out.join('\n')).toContain('name the variable instead');
  });

  it('reads a stored key only for a variable the environment leaves unset', async () => {
    const home = tempDir('keys-home-');
    const keychain = memoryKeychain();
    await runKeysCommand(
      { action: 'set', target: 'anthropic' },
      keysDeps(home, keychain).deps,
    );
    expect(keychainKeys({}, home, keychain)).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-stored',
    });
    expect(
      keychainKeys({ ANTHROPIC_API_KEY: 'from-env' }, home, keychain),
    ).toEqual({});
  });

  it('makes the provider usable with no environment variable', async () => {
    const home = tempDir('keys-home-');
    const keychain = memoryKeychain();
    await runKeysCommand(
      { action: 'set', target: 'anthropic' },
      keysDeps(home, keychain).deps,
    );
    const assembled = await assembleModels(
      tempDir('keys-cwd-'),
      {},
      {
        home,
        keychain,
      },
    );
    expect(assembled.providers.get('anthropic')?.usable).toBe(true);
    expect(assembled.keychainSecrets).toEqual(['sk-ant-stored']);
    const without = await assembleModels(
      tempDir('keys-cwd-'),
      {},
      {
        home: tempDir('keys-empty-home-'),
        keychain,
      },
    );
    expect(without.providers.get('anthropic')?.usable).toBe(false);
  });
});

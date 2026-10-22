// Provider keys in the operating system's keychain. `kubic keys set` stores
// a key under its variable name and records the name — never the value — in
// ~/.kubic/keychain.json; assembling the model catalogue reads each recorded
// key whose variable the environment leaves unset, so the key reaches its
// provider with no environment variable, and the run scrubs it like any
// other live key. A variable set in the environment wins.

import { join } from 'node:path';
import { createNodeFileBridge, type FileBridge } from '@kubic/exec/file-bridge';
import type { Keychain } from '@kubic/exec/keychain';

type Env = Readonly<Record<string, string | undefined>>;
type Bridge = Pick<FileBridge, 'exists' | 'readTextFile' | 'writeFile'>;

function keychainIndexPath(home: string): string {
  return join(home, '.kubic', 'keychain.json');
}

/** The variable names `kubic keys` stored; none when the index is absent. */
export function readKeychainIndex(
  home: string,
  bridge: Bridge = createNodeFileBridge('/'),
): string[] {
  const path = keychainIndexPath(home);
  try {
    if (!bridge.exists(path)) return [];
    const parsed = JSON.parse(bridge.readTextFile(path)) as {
      variables?: unknown;
    };
    return Array.isArray(parsed.variables)
      ? parsed.variables.filter(
          (name): name is string =>
            typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name),
        )
      : [];
  } catch {
    return [];
  }
}

export function writeKeychainIndex(
  home: string,
  variables: readonly string[],
  bridge: Bridge = createNodeFileBridge('/'),
): void {
  bridge.writeFile(
    keychainIndexPath(home),
    `${JSON.stringify({ variables: [...new Set(variables)].sort() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/**
 * The stored keys whose variables `env` leaves unset, by variable name;
 * nothing when no key was stored or the keychain cannot be used.
 */
export function keychainKeys(
  env: Env,
  home: string,
  keychain: Keychain,
): Record<string, string> {
  const wanted = readKeychainIndex(home).filter(
    (name) => env[name] === undefined || env[name] === '',
  );
  if (wanted.length === 0 || keychain.unavailable() !== undefined) return {};
  const keys: Record<string, string> = {};
  for (const name of wanted) {
    try {
      const value = keychain.get(name);
      if (value !== undefined && value !== '') keys[name] = value;
    } catch {
      // An entry that cannot be read leaves its provider keyless.
    }
  }
  return keys;
}

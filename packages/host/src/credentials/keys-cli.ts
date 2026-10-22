// `kubic keys set|list|remove`: provider keys in the operating system's
// keychain. A key is read from standard input (or typed without echo on a
// terminal), stored under its variable name, and never printed.

import {
  type CommandResult,
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import type { Keychain } from '@kubic/exec/keychain';
import { type CliIo, diagnosticsOf } from '../cli/index.js';
import { readKeychainIndex, writeKeychainIndex } from './keychain-keys.js';

export interface KeysCommandOptions {
  readonly action: 'set' | 'list' | 'remove';
  // A provider id (`anthropic`) or a variable name (`ANTHROPIC_API_KEY`).
  readonly target?: string;
}

export interface KeysDeps extends CliIo {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly keychain: Keychain;
  // The variable a built-in provider's key is read from.
  readonly variableFor: (provider: string) => Promise<string | undefined>;
  // The key: standard input, or a prompt without echo; null when cancelled.
  readonly readSecret: (variable: string) => Promise<string | null>;
}

const VARIABLE = /^[A-Z][A-Z0-9_]*$/;

async function variableOf(
  target: string | undefined,
  deps: KeysDeps,
): Promise<string | { refused: string }> {
  if (target === undefined || target === '') {
    return {
      refused: 'name a provider or a variable: kubic keys set anthropic',
    };
  }
  if (VARIABLE.test(target)) return target;
  const variable = await deps.variableFor(target);
  return (
    variable ?? {
      refused: `no key variable is known for provider '${target}': name the variable instead (kubic keys set KUBIC_GATEWAY_API_KEY)`,
    }
  );
}

export async function runKeysCommand(
  options: KeysCommandOptions,
  deps: KeysDeps,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  if (options.action === 'list') {
    const stored = readKeychainIndex(deps.home);
    if (stored.length === 0) {
      deps.out(`no key stored in ${deps.keychain.name}`);
      return { exitCode: EXIT_OK };
    }
    for (const variable of stored) {
      const shadowed = (deps.env[variable] ?? '') !== '';
      deps.out(
        `${variable}  ${shadowed ? 'stored, but the environment sets it (the environment wins)' : `from ${deps.keychain.name}`}`,
      );
    }
    return { exitCode: EXIT_OK };
  }
  const variable = await variableOf(options.target, deps);
  if (typeof variable !== 'string') {
    log.error(variable.refused);
    return { exitCode: EXIT_USAGE };
  }
  const unavailable = deps.keychain.unavailable();
  if (unavailable !== undefined) {
    log.error(unavailable);
    return { exitCode: EXIT_FAILED };
  }
  const stored = readKeychainIndex(deps.home);
  if (options.action === 'remove') {
    const removed = deps.keychain.remove(variable);
    writeKeychainIndex(
      deps.home,
      stored.filter((name) => name !== variable),
    );
    if (!removed) {
      log.error(`no ${variable} in ${deps.keychain.name}`);
      return { exitCode: EXIT_FAILED };
    }
    deps.out(`removed ${variable} from ${deps.keychain.name}`);
    return { exitCode: EXIT_OK };
  }
  const secret = await deps.readSecret(variable);
  if (secret === null) return { exitCode: EXIT_CANCELLED };
  const key = secret.trim();
  if (key === '') {
    log.error(`no key was given for ${variable}`);
    return { exitCode: EXIT_USAGE };
  }
  try {
    deps.keychain.set(variable, key);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return { exitCode: EXIT_FAILED };
  }
  writeKeychainIndex(deps.home, [...stored, variable]);
  deps.out(
    `stored ${variable} in ${deps.keychain.name}: Kubic uses it whenever ${variable} is not set`,
  );
  return { exitCode: EXIT_OK };
}

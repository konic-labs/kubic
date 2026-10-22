// The operating system's keychain, where `kubic keys` keeps provider keys:
// the macOS keychain through `security`, the Secret Service (GNOME Keyring,
// KWallet) through libsecret's `secret-tool`. A key never travels on a
// command line, where other users' `ps` could read it: macOS gets it as hex
// through `security -i`'s standard input, and secret-tool reads it from its
// standard input. Entries live under the service `kubic`, one account per
// variable name.
//
// Lives in exec: only packages/exec spawns processes.

import { spawnSync } from 'node:child_process';

const SERVICE = 'kubic';
const ACCOUNT = /^[A-Z][A-Z0-9_]*$/;

/** @internal */
export interface KeychainRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: string;
}

export type KeychainRun = (
  command: string,
  args: readonly string[],
  input?: string,
) => KeychainRunResult;

export interface Keychain {
  // Where the keys are kept, for the messages (`the macOS keychain`).
  readonly name: string;
  // Why this machine has no keychain Kubic can use; undefined when it has.
  unavailable(): string | undefined;
  get(account: string): string | undefined;
  set(account: string, secret: string): void;
  remove(account: string): boolean;
}

const run: KeychainRun = (command, args, input) => {
  const result = spawnSync(command, [...args], {
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    ...(result.error === undefined ? {} : { error: result.error.message }),
  };
};

function checkAccount(account: string): void {
  if (!ACCOUNT.test(account)) {
    throw new Error(
      `${JSON.stringify(account)} is not a variable name (A-Z, 0-9 and _)`,
    );
  }
}

function macKeychain(exec: KeychainRun): Keychain {
  return {
    name: 'the macOS keychain',
    unavailable: () => undefined,
    get(account) {
      checkAccount(account);
      const result = exec('security', [
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
      ]);
      return result.status === 0
        ? result.stdout.replace(/\r?\n$/, '')
        : undefined;
    },
    set(account, secret) {
      checkAccount(account);
      const hex = Buffer.from(secret, 'utf8').toString('hex');
      const result = exec(
        'security',
        ['-i'],
        `add-generic-password -U -s ${SERVICE} -a ${account} -X ${hex}\n`,
      );
      if (result.status !== 0) {
        throw new Error(
          `the macOS keychain refused the key${result.error === undefined ? '' : `: ${result.error}`}`,
        );
      }
    },
    remove(account) {
      checkAccount(account);
      return (
        exec('security', [
          'delete-generic-password',
          '-s',
          SERVICE,
          '-a',
          account,
        ]).status === 0
      );
    },
  };
}

function secretService(exec: KeychainRun): Keychain {
  let missing: string | undefined | null = null;
  return {
    name: 'the Secret Service keyring',
    unavailable() {
      if (missing === null) {
        const probe = exec('secret-tool', []);
        missing =
          probe.error !== undefined && /ENOENT/.test(probe.error)
            ? 'secret-tool (libsecret) is not installed: install libsecret-tools, or set the key in the environment'
            : undefined;
      }
      return missing;
    },
    get(account) {
      checkAccount(account);
      const result = exec('secret-tool', [
        'lookup',
        'service',
        SERVICE,
        'account',
        account,
      ]);
      return result.status === 0 && result.stdout !== ''
        ? result.stdout.replace(/\r?\n$/, '')
        : undefined;
    },
    set(account, secret) {
      checkAccount(account);
      const result = exec(
        'secret-tool',
        [
          'store',
          `--label=Kubic ${account}`,
          'service',
          SERVICE,
          'account',
          account,
        ],
        secret,
      );
      if (result.status !== 0) {
        throw new Error(
          `the Secret Service refused the key${result.error === undefined ? '' : `: ${result.error}`}`,
        );
      }
    },
    remove(account) {
      checkAccount(account);
      return (
        exec('secret-tool', ['clear', 'service', SERVICE, 'account', account])
          .status === 0
      );
    },
  };
}

function noKeychain(platform: string): Keychain {
  const reason = `Kubic has no keychain support on ${platform}: set the key in the environment`;
  return {
    name: 'no keychain',
    unavailable: () => reason,
    get: () => undefined,
    set: () => {
      throw new Error(reason);
    },
    remove: () => false,
  };
}

/** This machine's keychain. */
export function osKeychain(
  platform: NodeJS.Platform = process.platform,
  exec: KeychainRun = run,
): Keychain {
  if (platform === 'darwin') return macKeychain(exec);
  if (platform === 'linux' || platform === 'freebsd') {
    return secretService(exec);
  }
  return noKeychain(platform);
}

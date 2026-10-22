// `kubic policy explain`, `kubic policy pull` and `kubic policy sign`: the
// managed-policy half of `kubic policy`. Explain reads the one runtime load;
// pull fetches the organization's signed remote policy into the cache the
// load verifies; sign writes the detached signature a managed file needs
// when its directory holds a policy.pub.

import { dirname, join } from 'node:path';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
} from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { type CliIo, diagnosticsOf } from '../cli/index.js';
import type { RuntimeConfig } from '../config/index.js';
import {
  MANAGED_KEY_FILE,
  managedConfigDirs,
  managedFilePath,
  managedKeyPath,
  parseManagedRemote,
  pullManagedPolicy,
  signManagedText,
  verifyManagedText,
} from '../config/index.js';
import { explainPolicy, renderPolicyExplain } from './explain.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runPolicyExplainCommand(
  options: { readonly json?: boolean },
  deps: CliIo & { readonly load: () => RuntimeConfig },
): Promise<CommandResult> {
  let runtime: RuntimeConfig;
  try {
    runtime = deps.load();
  } catch (error) {
    diagnosticsOf(deps).error(message(error));
    return { exitCode: EXIT_FAILED };
  }
  const explanation = explainPolicy(runtime);
  if (options.json === true) {
    deps.out(formatJson(explanation));
    return { exitCode: EXIT_OK };
  }
  for (const line of renderPolicyExplain(explanation)) deps.out(line);
  return { exitCode: EXIT_OK };
}

export interface PolicyPullDeps extends CliIo {
  readonly home: string;
  // The directories the managed config is searched in (tests).
  readonly dirs?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export async function runPolicyPullCommand(
  deps: PolicyPullDeps,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  const files = createNodeFileBridge('/');
  const path = managedFilePath(
    files,
    'config.toml',
    deps.dirs ?? managedConfigDirs(),
  );
  let remote: ReturnType<typeof parseManagedRemote>;
  try {
    remote = parseManagedRemote(files, path);
  } catch (error) {
    log.error(message(error));
    return { exitCode: EXIT_FAILED };
  }
  if (remote === undefined) {
    log.error(
      `no remote policy to pull: the managed config ${path} sets no [managed] url`,
    );
    return { exitCode: EXIT_FAILED };
  }
  try {
    const pulled = await pullManagedPolicy({
      home: deps.home,
      remote,
      keyPath: managedKeyPath(files, path),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    deps.out(
      `fetched the managed policy from ${pulled.url} (${pulled.fetchedAt}); its signature verified`,
    );
    return { exitCode: EXIT_OK };
  } catch (error) {
    log.error(`could not pull the managed policy: ${message(error)}`);
    return { exitCode: EXIT_FAILED };
  }
}

export async function runPolicySignCommand(
  options: { readonly key: string; readonly file: string },
  deps: CliIo,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  const files = createNodeFileBridge('/');
  let signature: string;
  let text: string;
  try {
    text = files.readTextFile(options.file);
    signature = signManagedText(files.readTextFile(options.key), text);
  } catch (error) {
    log.error(message(error));
    return { exitCode: EXIT_FAILED };
  }
  const signaturePath = `${options.file}.sig`;
  files.writeFile(signaturePath, `${signature}\n`, { mode: 0o644 });
  deps.out(`wrote ${signaturePath}`);
  // Say whether the key the file's directory trusts accepts it.
  const keyPath = join(dirname(options.file), MANAGED_KEY_FILE);
  if (managedKeyPath(files, options.file) !== undefined) {
    try {
      verifyManagedText(files, options.file, text, keyPath, signaturePath);
      deps.out(`the signature verifies with ${keyPath}`);
    } catch {
      log.warn(
        `the signature does not verify with ${keyPath}: that key will refuse ${options.file}`,
      );
    }
  }
  return { exitCode: EXIT_OK };
}

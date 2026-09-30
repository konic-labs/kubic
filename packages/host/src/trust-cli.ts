// `kubic trust` (issue #228; §35.1, §78): the operator-facing half of the
// persistent project-trust store. Presentation only — the decision itself
// lives in `packages/host/src/config/trust-store.ts`, and the config load
// reads the same file, so this command can never record something the
// loader will not honour.
//
// Exit codes: 0 recorded/revoked/listed, 1 a broken store (named, exit 1 —
// the operator sees the file to fix instead of a silent overwrite); a bad
// invocation (a path that is not a directory, --list with --revoke) is
// `CliUsageError` → exit 2 through the commander action.

import { join, resolve } from 'node:path';
import {
  CliUsageError,
  EXIT_FAILED,
  EXIT_OK,
} from '../../core/src/cli/exit-codes.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { type CliIo, diagnosticsOf } from './cli-io.js';
import {
  canonicalTrustPath,
  type ProjectTrustStore,
} from './config/trust-store.js';

const BRIDGE = createNodeFileBridge('/');

// The parsed `kubic trust` invocation (commander owns the argv:
// apps/kubic/src/commands/solo.ts). Absent `path` means the cwd.
export interface TrustCommandOptions {
  readonly path?: string;
  readonly revoke?: boolean;
  readonly list?: boolean;
}

export interface TrustCommandDeps extends CliIo {
  // The user's store (prod: ~/.kubic/trust.json).
  readonly store: ProjectTrustStore;
  // The default target when no path operand is given.
  readonly cwd: string;
}

function projectConfigPath(dir: string): string {
  return join(resolve(dir), '.kubic', 'config.toml');
}

// The grant target must be a directory: a project root is what later
// invocations resolve, and recording a file path would be a decision no
// load could ever honour. The probe resolves against the process cwd, so a
// relative operand works, and it FOLLOWS symlinks: the store keys a grant by
// the canonical path, so a symlink to a project directory is a project
// directory. The bridge only lstats, so the operand is canonicalised first
// (realpath) and the real path is what gets inspected.
function requireDirectory(dir: string): void {
  let isDirectory = false;
  try {
    const absolute = resolve(dir);
    // realPath throws for a missing or dangling operand: no such directory.
    isDirectory = BRIDGE.fileInfo(
      BRIDGE.realPath?.(absolute) ?? absolute,
    ).isDirectory;
  } catch {
    throw new CliUsageError(`no such directory: ${dir}`);
  }
  if (!isDirectory) throw new CliUsageError(`not a directory: ${dir}`);
}

export function runTrustCommand(
  options: TrustCommandOptions,
  deps: TrustCommandDeps,
): number {
  const diagnose = diagnosticsOf(deps);
  try {
    if (options.list === true) {
      if (options.revoke === true || options.path !== undefined) {
        throw new CliUsageError(
          '--list takes neither --revoke nor a path — it reports every recorded decision',
        );
      }
      const entries = deps.store.entries();
      if (entries.length === 0) {
        deps.out(
          `no project trust decisions recorded (store: ${deps.store.file})`,
        );
        return EXIT_OK;
      }
      for (const entry of entries) {
        deps.out(`${entry.decision ? 'trusted ' : 'declined'} ${entry.path}`);
      }
      return EXIT_OK;
    }
    const target = options.path ?? deps.cwd;
    requireDirectory(target);
    const key = canonicalTrustPath(target);
    if (options.revoke === true) {
      // Removing the key — not storing `false` — is what brings the
      // interactive prompt back; `kubic trust` is the way to accept again.
      deps.store.set(target, null);
      deps.out(`revoked project trust for ${key}`);
      deps.out(
        "the project layer there is refused again until you run 'kubic trust'",
      );
      return EXIT_OK;
    }
    deps.store.set(target, true);
    deps.out(`trusted project ${key} (store: ${deps.store.file})`);
    const configPath = projectConfigPath(target);
    deps.out(
      BRIDGE.exists(configPath)
        ? `project config ${configPath} will load`
        : `no project config at ${configPath} yet — this grant applies when one appears`,
    );
    // The grant is per project tree, not per file: say what else it unlocks.
    deps.out(
      "this grant also covers the project's models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default) and its project skills",
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    diagnose.error(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }
}

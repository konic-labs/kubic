// The pins a re-execution tier needs: model pins, the --lockfile digests, a
// worktree override and the --role-config for live runs.

import { createHash } from 'node:crypto';
import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { EXIT_USAGE, EXIT_WORKSPACE } from '@kubic/core/cli/exit-codes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { fail } from './envelope.js';
import { readFile } from './recorded.js';
import type {
  ReplayCommandDeps,
  ReplayOptions,
  ReplayRefusal,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isModelPin(value: string): boolean {
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
}

// Pin artifact for the Deterministic tier: a JSON file pinning the
// exact model the re-execution may use, plus optional prompt/tool digests.
// Fail-closed: the requested --model must be pinned, and a pinned digest
// must match what is about to be re-executed — the pins were
// required and then ignored before this.
//
// Format:
//   { "models": { "provider/id": {...} | "provider": ["id", ...] },
//     "prompt": { "digest": "sha256:<hex>" }?,   // the re-run prompt text
//     "tools":  { "digest": "sha256:<hex>" }? }  // sorted distinct tools
function sha256Digest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function isPinnedModel(models: Record<string, unknown>, pin: string): boolean {
  if (pin in models) return true;
  const slash = pin.indexOf('/');
  const provider = pin.slice(0, slash);
  const id = pin.slice(slash + 1);
  const entry = models[provider];
  if (Array.isArray(entry)) return entry.includes(id);
  // A provider keyed to a record of its pinned ids.
  if (isRecord(entry)) return id in entry;
  return false;
}

function recordedToolsDigest(trajectory: TrajectoryExport): string {
  const tools = [...new Set(trajectory.actions.map((action) => action.tool))]
    .sort()
    .join('\n');
  return sha256Digest(tools);
}

function checkDigestPin(
  parsed: Record<string, unknown>,
  path: string,
  key: 'prompt' | 'tools',
  actual: string,
): ReplayRefusal | null {
  const entry = parsed[key];
  if (entry === undefined) return null;
  if (!isRecord(entry) || typeof entry.digest !== 'string') {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} ${key} pin must be an object with a "digest" string`,
      exit: EXIT_USAGE,
    };
  }
  if (entry.digest !== actual) {
    return {
      code: 'lockfile-mismatch',
      message: `lockfile ${JSON.stringify(path)} ${key} pin ${entry.digest} does not match the recorded ${key} (${actual}) — refusing a deterministic replay whose ${key} differs from its pin`,
      exit: EXIT_USAGE,
    };
  }
  return null;
}

export function checkLockfile(
  path: string,
  model: string,
  trajectory: TrajectoryExport,
): { ok: true } | ReplayRefusal {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'lockfile-unreadable',
      message: `cannot read lockfile ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} is not valid JSON — deterministic replay needs a pinned models record`,
      exit: EXIT_USAGE,
    };
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.models) ||
    Object.keys(parsed.models).length === 0
  ) {
    return {
      code: 'lockfile-invalid',
      message: `lockfile ${JSON.stringify(path)} must be a JSON object with a non-empty "models" record — deterministic replay needs pinned models`,
      exit: EXIT_USAGE,
    };
  }
  if (!isPinnedModel(parsed.models, model)) {
    return {
      code: 'lockfile-mismatch',
      message: `lockfile ${JSON.stringify(path)} does not pin model ${JSON.stringify(model)} — refusing a deterministic replay at an unpinned model`,
      exit: EXIT_USAGE,
    };
  }
  const promptPin = checkDigestPin(
    parsed,
    path,
    'prompt',
    sha256Digest(trajectory.task.objective),
  );
  if (promptPin !== null) return promptPin;
  const toolsPin = checkDigestPin(
    parsed,
    path,
    'tools',
    recordedToolsDigest(trajectory),
  );
  if (toolsPin !== null) return toolsPin;
  return { ok: true };
}

function checkWorktreeOverride(
  path: string,
): { ok: true } | { code: string; message: string; exit: ExitCode } {
  let exists = false;
  try {
    exists = createNodeFileBridge(process.cwd()).exists(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      code: 'worktree-unavailable',
      message: `worktree override ${JSON.stringify(path)} does not exist — refusing a replay against a missing worktree`,
      exit: EXIT_WORKSPACE,
    };
  }
  return { ok: true };
}

export function resolveWorktreeOverride(
  deps: ReplayCommandDeps,
  options: ReplayOptions,
  recordedPath: string,
):
  | { worktree: string; changed: string[]; experimental: string[] }
  | { exit: ExitCode } {
  if (options.worktree === undefined) {
    return { worktree: recordedPath, changed: [], experimental: [] };
  }
  const checked = checkWorktreeOverride(options.worktree);
  if ('exit' in checked) {
    fail(
      deps,
      options,
      options.trajectory,
      checked.exit,
      checked.code,
      checked.message,
    );
    return { exit: checked.exit };
  }
  return {
    worktree: options.worktree,
    changed: ['worktree'],
    experimental: ['worktree'],
  };
}

// The live tier's pin artifact: a JSON file naming the role
// the re-execution boots as — `{"role": "<name>"}`. The name is resolved
// from `.kubic/roles/<name>.md` in the pinned worktree, so the role's
// tools and prompt actually apply. Fail-closed: a role config that names
// no role is refused here (exit 2), never checked-then-ignored.
export function checkRoleConfig(
  path: string,
): { ok: true; role: string } | ReplayRefusal {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'role-config-unreadable',
      message: `cannot read role config ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      code: 'role-config-invalid',
      message: `role config ${JSON.stringify(path)} is not valid JSON — live replay needs {"role": "<name>"}`,
      exit: EXIT_USAGE,
    };
  }
  const role = isRecord(parsed) ? parsed.role : undefined;
  if (typeof role !== 'string' || role.trim() === '') {
    return {
      code: 'role-config-invalid',
      message: `role config ${JSON.stringify(path)} must be a JSON object with a non-empty "role" name — live replay needs the pinned role`,
      exit: EXIT_USAGE,
    };
  }
  return { ok: true, role: role.trim() };
}

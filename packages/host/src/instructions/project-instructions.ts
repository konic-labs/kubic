// Project instructions: the `AGENTS.md` files other coding agents read, loaded
// into the system prompt the same way. The search walks the project chain the
// skills loader walks — the repository root down to the working directory, the
// working directory alone outside a repository — and reads one `AGENTS.md` per
// directory, outermost first, so the file nearest the work comes last.
//
// Trust is per directory, like the project skills: a file loads only when the
// tree it lives in is trusted (a grant for `/repo` covers `/repo/AGENTS.md`
// from any subdirectory; `/repo/pkg/AGENTS.md` needs a grant for `/repo/pkg`),
// and the grant's fingerprint covers the file, so an edited `AGENTS.md` asks
// again. A file from an untrusted directory is left out and named.
//
// Each file reaches the prompt up to a byte bound; a longer one is cut at the
// bound, marked as cut in the prompt, and named. Reads go through the exec
// FileBridge (I/O confinement); a file that cannot be read is named and
// skipped, never fatal — instructions are context, never a gate.

import { join } from 'node:path';
import { projectChain } from '@kubic/agent/skills';
import type { FileBridge } from '@kubic/exec/file-bridge';
import type { DoctorCheck } from '../doctor/index.js';

const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md';

// The most of one file that reaches the prompt.
const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

interface LoadedInstructionsFile {
  readonly path: string;
  // The file's size on disk.
  readonly bytes: number;
  // True when only the first `maxBytes` reached the prompt.
  readonly truncated: boolean;
}

interface SkippedInstructionsFile {
  readonly path: string;
  readonly reason: string;
}

export interface ProjectInstructions {
  // The prompt section, or undefined when no file loaded — undefined, not an
  // empty block, so a project without instructions assembles the same prompt
  // bytes it always did.
  readonly block: string | undefined;
  readonly loaded: readonly LoadedInstructionsFile[];
  readonly skipped: readonly SkippedInstructionsFile[];
  // False when `[agent] projectInstructions = false` turned the search off.
  readonly enabled: boolean;
}

export interface ProjectInstructionsOptions {
  readonly bridge: Pick<FileBridge, 'exists' | 'readBinaryFile'>;
  readonly cwd: string;
  // The per-directory trust check (the trust store's, with the env opt-in).
  readonly trustProject: (dir: string) => boolean;
  readonly enabled?: boolean;
  readonly maxBytes?: number;
}

/** @internal */
export const NO_PROJECT_INSTRUCTIONS: ProjectInstructions = {
  block: undefined,
  loaded: [],
  skipped: [],
  enabled: false,
};

const PREAMBLE =
  "Project instructions from the repository's AGENTS.md files, outermost directory first. Follow them; where two disagree, the file nearer the working directory wins.";

function present(
  bridge: ProjectInstructionsOptions['bridge'],
  path: string,
): boolean {
  try {
    return bridge.exists(path);
  } catch {
    return false;
  }
}

// The first `maxBytes` as text, never ending inside a multi-byte character.
function prefixText(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(bytes.byteLength, maxBytes);
  // Back off continuation bytes (10xxxxxx) so the cut lands on a boundary.
  if (end < bytes.byteLength) {
    while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  }
  return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
}

function fileSection(path: string, text: string, cut?: string): string {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return `<file path="${path}">\n${body}${cut === undefined ? '' : `${cut}\n`}</file>`;
}

export function loadProjectInstructions(
  options: ProjectInstructionsOptions,
): ProjectInstructions {
  if (options.enabled === false) return NO_PROJECT_INSTRUCTIONS;
  const maxBytes = options.maxBytes ?? PROJECT_INSTRUCTIONS_MAX_BYTES;
  const loaded: LoadedInstructionsFile[] = [];
  const skipped: SkippedInstructionsFile[] = [];
  const sections: string[] = [];
  const chain = projectChain(options.bridge, options.cwd);
  for (const dir of chain) {
    const path = join(dir, PROJECT_INSTRUCTIONS_FILE);
    if (!present(options.bridge, path)) continue;
    if (!options.trustProject(dir)) {
      skipped.push({
        path,
        reason: `the project directory ${dir} is not trusted — run 'kubic trust ${dir}' to accept it`,
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = options.bridge.readBinaryFile(path);
    } catch (error) {
      skipped.push({
        path,
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const truncated = bytes.byteLength > maxBytes;
    const text = prefixText(bytes, maxBytes);
    if (text.trim() === '') continue;
    sections.push(
      fileSection(
        path,
        text,
        truncated
          ? `[cut: the first ${maxBytes} of ${bytes.byteLength} bytes]`
          : undefined,
      ),
    );
    loaded.push({ path, bytes: bytes.byteLength, truncated });
  }
  return {
    block:
      sections.length === 0
        ? undefined
        : `<project_instructions>\n${PREAMBLE}\n${sections.join('\n')}\n</project_instructions>`,
    loaded,
    skipped,
    enabled: true,
  };
}

// One line per file a run should hear about: a cut file and a skipped one.
// Silent when every file loaded whole.
export function projectInstructionsNotices(
  instructions: ProjectInstructions,
  maxBytes = PROJECT_INSTRUCTIONS_MAX_BYTES,
): string[] {
  return [
    ...instructions.loaded
      .filter((file) => file.truncated)
      .map(
        (file) =>
          `${file.path} is ${file.bytes} bytes: only the first ${maxBytes} reach the prompt`,
      ),
    ...instructions.skipped.map(
      (file) => `${file.path} not loaded: ${file.reason}`,
    ),
  ];
}

// The `kubic doctor` line: the files a run here would load, and any it would
// cut or leave out (a warning: instructions the user wrote are not reaching
// the model).
export function projectInstructionsDoctorCheck(
  instructions: ProjectInstructions,
): DoctorCheck {
  const label = 'project instructions';
  if (!instructions.enabled) {
    return {
      id: 'instructions',
      label,
      status: 'skip',
      reason: 'skipped',
      detail: 'off ([agent] projectInstructions = false)',
    };
  }
  const notices = projectInstructionsNotices(instructions);
  const loaded =
    instructions.loaded.length === 0
      ? 'no AGENTS.md loaded'
      : `${instructions.loaded.length} loaded (${instructions.loaded
          .map((file) => file.path)
          .join(', ')})`;
  return {
    id: 'instructions',
    label,
    status: notices.length === 0 ? 'pass' : 'warn',
    reason: notices.length === 0 ? 'ok' : 'policy-mismatch',
    detail: notices.length === 0 ? loaded : `${loaded}; ${notices.join('; ')}`,
  };
}

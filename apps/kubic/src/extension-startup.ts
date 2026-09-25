// Composition-root extension startup wiring (issue #93). All mechanism
// lives in @kubic/extensions; this file is the app-side adapter: it supplies
// the prod inputs (real FileBridge, real anchor dir, real trust options),
// picks the commands that load the bundle set, and turns a load into the
// doctor posture — always from the SAME startup object, never a second probe.
//
// Fail-closed doctrine, stated once here: a lane boot (`run`, `tui`,
// `orchestrate`) REFUSES to start when the bundle is missing or refused
// (ExtensionStartupError escapes to the command's exit path). `doctor` is the
// posture surface: it must still print the failure line, so it takes the
// same load as DATA and reports the named error — the CLI exits non-zero.

import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import type {
  BundleLoad,
  PostureOptions,
} from '../../../packages/extensions/src/index.js';
import {
  commandLoadsExtensions,
  loadFirstPartyBundle,
  postureFromStartup,
  startFirstPartyExtensions,
} from '../../../packages/extensions/src/index.js';

export interface ExtensionPostureInput {
  ok: boolean;
  loaded: string[];
  refusedCount: number;
  detail: string;
}

export interface ExtensionStartupCall {
  /** Progress receipt: one line naming what loaded, or why it was refused. */
  receipt?: (line: string) => void;
  /** Overrides the prod inputs; tests drive missing/tampered bundles here. */
  options?: PostureOptions;
}

// Prod inputs for the startup load: the bundle sits at <repoRoot>/skills/
// budget and the walk starts from this module's own directory (the src
// layout finds it in 3 levels, the dist layout in 4 — the bound startup.ts
// documents). File access goes through the exec FileBridge (I/O confinement,
// §9): the composition root never imports node:fs directly.
export function prodExtensionStartupOptions(cwd: string): PostureOptions {
  return {
    anchorDir: dirname(fileURLToPath(import.meta.url)),
    files: createNodeFileBridge('/'),
    trust: { homeDir: homedir(), cwd, allowlist: [] },
  };
}

// The shared startup load for the lane boots and for doctor.
//
// - Commands outside EXTENSION_STARTUP_COMMANDS return undefined (nothing
//   loads; `diff`, `--version` and friends stay untouched).
// - `doctor` never throws: the posture surface reports the degradation as
//   data (ok:false + the named error) so the check line prints it.
// - Every other listed command is a lane boot: a degraded load THROWS
//   ExtensionStartupError — the process refuses to run bare.
export async function loadExtensionStartup(
  command: string | undefined,
  cwd: string,
  call: ExtensionStartupCall = {},
): Promise<BundleLoad | undefined> {
  if (!commandLoadsExtensions(command)) return undefined;
  const options = call.options ?? prodExtensionStartupOptions(cwd);
  const load =
    command === 'doctor'
      ? await loadFirstPartyBundle(options)
      : await startFirstPartyExtensions(options);
  call.receipt?.(`extensions: ${load.detail}`);
  return load;
}

// Doctor's posture: a pure projection of the startup object above. Counts
// cannot drift from what loaded because there is no second probe.
export async function extensionPostureForDoctor(
  call: ExtensionStartupCall = {},
): Promise<ExtensionPostureInput> {
  const load = await loadExtensionStartup('doctor', process.cwd(), call);
  if (load === undefined) {
    throw new Error('doctor must load the extension startup object');
  }
  return postureFromStartup(load);
}

// Composition-root config wiring (issue #90): `main.ts` calls
// `loadCliConfig(...)` once and hands the result to the commands that need
// it. Everything else lives in the host package — this file only maps the
// process's real environment, cwd and trust posture onto `loadRuntimeConfig`
// and exposes the small seams the CLI consumes:
//
//   kubicConfigLoader(result)   → `kubic config` (human + --json view)
//   doctorPolicyLoader(result)  → `kubic doctor`'s policy check
//   runtimeModelPin(result)     → provider/model selection for `kubic run`
//
// Every seam fails closed on a refused config: they throw (or return
// undefined) with the named reason rather than falling back to a default,
// because a silent default is how a config file stops configuring anything.
//
// File access goes through the exec FileBridge (I/O confinement): this
// module never imports node:fs.

import { homedir } from 'node:os';
import type { PermissionClasses } from '../../../packages/agents/src/policy.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import type { JournalRetention } from '../../../packages/exec/src/journal.js';
import {
  buildConfigDoctorInput,
  configDoctorProbe,
} from '../../../packages/host/src/config/config-doctor.js';
import {
  checkWorkspaceIgnoreSplit,
  effectiveConfigView,
  loadRuntimeConfig,
  type RuntimeConfig,
} from '../../../packages/host/src/config/runtime.js';
import type { DepProbe } from '../../../packages/host/src/doctor.js';
import type { ModelSelection } from '../../../packages/worker/src/model-select.js';

export interface CliConfigResult {
  // Present only when the load succeeded. A refusal leaves it undefined:
  // callers never run on invented values.
  runtime: RuntimeConfig | undefined;
  // Named reason the config was refused (unknown/unsupported key, a
  // distrusted project layer, a budget key, a secret ref in config).
  error: string | undefined;
  // The repo's committed-vs-ignored split (§35/D35), reported by
  // `kubic config` and by doctor: the five runtime prefixes must be ignored
  // and config.toml + roles/*.md must stay committable.
  ignoreSplit: { missing: string[]; checked: string[]; applicable: boolean };
}

export interface CliConfigOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  projectTrusted?: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One load for the whole process: paths per §35.1, the project layer behind
// the trust gate, the documented env overrides above the file layers.
export function loadCliConfig(options: CliConfigOptions = {}): CliConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const bridge = createNodeFileBridge(cwd);
  const ignoreSplit = checkWorkspaceIgnoreSplit(bridge, cwd);
  try {
    const runtime = loadRuntimeConfig({
      bridge,
      home,
      cwd,
      env,
      ...(options.projectTrusted === undefined
        ? {}
        : { projectTrusted: options.projectTrusted }),
    });
    return { runtime, error: undefined, ignoreSplit };
  } catch (error) {
    return { runtime: undefined, error: message(error), ignoreSplit };
  }
}

// The config the rest of the process runs on; a refusal throws with its
// named reason instead of returning defaults.
export function requireRuntimeConfig(result: CliConfigResult): RuntimeConfig {
  if (result.runtime === undefined) {
    throw new Error(result.error ?? 'config refused');
  }
  return result.runtime;
}

// Commands whose whole job is to tell the operator about the effective
// configuration (or about a refusal) must still run when the load was
// refused — otherwise the named reason has nowhere to surface.
const CONFIG_REPORTING_COMMANDS = new Set(['config', 'doctor']);

// The modes that execute an agent under the configuration. They may not
// proceed on defaults once the load was refused: silently running on
// built-in values while the user believes their .kubic/config.toml is in
// force is precisely the defect issue #90 exists to fix (§35.1 fail-closed).
const CONFIG_CONSUMING_COMMANDS = new Set(['run', 'orchestrate', 'tui']);

// Exit code for a refused config on the given command, or undefined when the
// command may proceed. Kept beside the load so the policy lives in one place:
// the caller prints `result.error` and returns this code (1 = `failed`, the
// same code doctor uses for a config-shaped failure).
export function configRefusalExit(
  result: CliConfigResult,
  command: string | undefined,
): number | undefined {
  if (result.runtime !== undefined) return undefined;
  if (command === undefined) return undefined;
  if (CONFIG_REPORTING_COMMANDS.has(command)) return undefined;
  return CONFIG_CONSUMING_COMMANDS.has(command) ? 1 : undefined;
}

// `kubic config` loader: the command renders exactly what this returns.
export function kubicConfigLoader(
  result: CliConfigResult,
): () => RuntimeConfig {
  return () => requireRuntimeConfig(result);
}

// `kubic doctor` policy source: the config-sourced approval policy. A
// refused config throws here, which doctor renders as a failing
// `policy:approvals (policy-mismatch)` check naming the reason — the
// operator sees a broken key, never a green run on ignored config.
export function doctorPolicyLoader(result: CliConfigResult): () => unknown {
  return () => requireRuntimeConfig(result).approvals.policy;
}

// Provider/model selection for `kubic run`: the configured pin when one is
// set, otherwise undefined (first-registered provider, the existing
// behaviour). Validated against the live catalog by the lane's own
// selectModel, which fails the run by name on an unknown provider/model.
export function runtimeModelPin(
  result: CliConfigResult,
): ModelSelection | undefined {
  const selection = result.runtime?.model;
  if (selection === undefined) return undefined;
  return { provider: selection.provider, id: selection.id };
}

// The remaining `kubic run` projections (issue #90): the permission classes
// the lane derives its tool allowlist from (§40) and the journal retention
// bound enforced on every append (§42.4). A refused config contributes
// nothing here — the run itself fails closed before this matters.
export function runtimeRunDeps(result: CliConfigResult): {
  policyClasses?: PermissionClasses;
  journalRetention?: JournalRetention;
} {
  const runtime = result.runtime;
  if (runtime === undefined) return {};
  return {
    policyClasses: { ...runtime.permissions.classes },
    journalRetention:
      runtime.journal.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: runtime.journal.maxAgeMs },
  };
}

// Installed-policy classes (issue #86): the projection `doctor` and the `tui`
// path read, over the SAME config load `kubic run` uses. Absent config →
// absent classes → installSoloPolicy's documented SOLO_DEFAULTS, which is
// exactly what a config-less run installs, so doctor's line and the lane's
// posture are the same object (§40.3).
export function installedPolicyClasses(result: CliConfigResult): {
  classes?: PermissionClasses;
} {
  const classes = runtimeRunDeps(result).policyClasses;
  return classes === undefined ? {} : { classes };
}

// `kubic doctor` config probe: the same load the rest of the process uses,
// projected onto doctor's dependency-probe shape (doctor.ts is not this
// issue's file and has no generic section hook, so the check rides the
// `checkDeps` channel and renders in both the human and --json output).
export function doctorConfigProbe(result: CliConfigResult): DepProbe {
  const { missing, applicable } = result.ignoreSplit;
  if (result.runtime === undefined) {
    return configDoctorProbe(
      buildConfigDoctorInput({
        error: result.error ?? 'config refused',
        ignoreSplitMissing: missing,
        ignoreSplitApplicable: applicable,
      }),
    );
  }
  const view = effectiveConfigView(result.runtime);
  return configDoctorProbe(
    buildConfigDoctorInput({
      values: view.values,
      projectTrusted: view.projectTrusted,
      budgetsConfigured: view.budgets.configured,
      ignoreSplitMissing: missing,
      ignoreSplitApplicable: applicable,
    }),
  );
}

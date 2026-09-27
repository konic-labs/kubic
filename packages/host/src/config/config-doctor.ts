// Doctor's config section (issue #90, criterion 3): unknown or unsupported
// keys fail closed with a named reason AND appear in doctor — nothing is
// silently ignored.
//
// Seam note: doctor.ts is not this issue's file, and its `DoctorDeps` has no
// generic section hook, so the config check rides the existing `checkDeps`
// channel (the same `{ id, ok, detail }` shape a dependency probe uses).
// The composition root injects it; doctor renders it in both the human and
// the `--json` output without doctor.ts being touched.
import type { DepProbe } from '../doctor.js';

export interface ConfigDoctorInput {
  // Undefined when the load was refused; `refusal` then carries the reason.
  effectiveValues: number | undefined;
  refusal: string | undefined;
  projectTrusted: boolean | undefined;
  // Accepted keys whose effective value has NO row in the key-effect table
  // (issue #133): the table is the claim that every accepted key does
  // something, so a key it cannot explain is reported by name, not glossed.
  unexplainedKeys: string[];
  // The committed-vs-runtime ignore split for this workspace (§35/D35):
  // runtime prefixes absent from both the repo .gitignore and its local
  // exclude file are reported by name. Outside a git repository the check
  // does not apply (there is no commit path to protect).
  ignoreSplitMissing: string[];
  ignoreSplitApplicable: boolean;
  budgetsConfigured: boolean;
}

export const CONFIG_DOCTOR_ID = 'config-load';

// A refused config is a failure, not a disclosure: the run must not proceed
// on invented values, so the operator has to fix the key. The refusal text
// is the ConfigError message, which names the layer and the key.
export function configDoctorProbe(input: ConfigDoctorInput): DepProbe {
  if (input.refusal !== undefined) {
    return {
      id: CONFIG_DOCTOR_ID,
      ok: false,
      detail: `config refused (fail closed, no defaults applied): ${input.refusal}`,
    };
  }
  if (input.unexplainedKeys.length > 0) {
    return {
      id: CONFIG_DOCTOR_ID,
      ok: false,
      detail: `accepted key(s) with no effect row in RUNTIME_KEY_EFFECTS: ${input.unexplainedKeys.join(', ')}`,
    };
  }
  if (input.ignoreSplitMissing.length > 0) {
    return {
      id: CONFIG_DOCTOR_ID,
      ok: false,
      detail: `runtime state is not ignored in this repo (missing from .gitignore and .git/info/exclude): ${input.ignoreSplitMissing.join(', ')}`,
    };
  }
  return {
    id: CONFIG_DOCTOR_ID,
    ok: true,
    detail:
      `${input.effectiveValues ?? 0} effective value(s); project layer ${input.projectTrusted === true ? 'trusted' : 'not trusted'}; ` +
      `budgets ${input.budgetsConfigured ? 'configured' : 'none (§71: nothing is capped until you configure a limit)'}; ` +
      `runtime ignore split ${input.ignoreSplitApplicable ? 'complete' : 'not applicable (not a git repository)'}`,
  };
}

// The composition root feeds this from the same load `kubic config` renders,
// so doctor and the command can never disagree about the effective values.
export function buildConfigDoctorInput(
  loaded:
    | {
        values: Array<{
          key: string;
          value: string;
          layer: string;
          disposition: string;
        }>;
        projectTrusted: boolean;
        budgetsConfigured: boolean;
        ignoreSplitMissing: string[];
        ignoreSplitApplicable: boolean;
      }
    | {
        error: string;
        ignoreSplitMissing: string[];
        ignoreSplitApplicable: boolean;
      },
): ConfigDoctorInput {
  if ('error' in loaded) {
    return {
      effectiveValues: undefined,
      refusal: loaded.error,
      projectTrusted: undefined,
      unexplainedKeys: [],
      ignoreSplitMissing: loaded.ignoreSplitMissing,
      ignoreSplitApplicable: loaded.ignoreSplitApplicable,
      budgetsConfigured: false,
    };
  }
  return {
    effectiveValues: loaded.values.length,
    refusal: undefined,
    projectTrusted: loaded.projectTrusted,
    // 'unknown' is the view's own word for "no effect row explains this key"
    // (issue #133) — one derivation, so doctor and `kubic config` agree.
    unexplainedKeys: loaded.values
      .filter((value) => value.disposition === 'unknown')
      .map((value) => value.key),
    ignoreSplitMissing: loaded.ignoreSplitMissing,
    ignoreSplitApplicable: loaded.ignoreSplitApplicable,
    budgetsConfigured: loaded.budgetsConfigured,
  };
}

// Doctor's config section: unknown or unsupported
// keys fail closed with a named reason AND appear in doctor — nothing is
// silently ignored.
//
// Seam note: doctor.ts is outside this module, and its `DoctorDeps` has no
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
  // How the project layer was trusted (or not) — the store
  // decision, the env opt-in and the store path. Optional so existing
  // fixtures stay valid; absent falls back to the boolean wording.
  projectTrust:
    | {
        decision: boolean | null;
        envTrust: boolean;
        storePath: string;
        // The store exists but could not be read or
        // parsed — named instead of reported as "no decision recorded".
        storeError?: string;
      }
    | undefined;
  // Accepted keys whose effective value has NO row in the key-effect table: the
  // table is the claim that every accepted key does something, so a key it
  // cannot explain is reported by name, not glossed.
  unexplainedKeys: string[];
  // The committed-vs-runtime ignore split for this workspace:
  // runtime prefixes absent from both the repo .gitignore and its local
  // exclude file are reported by name. Outside a git repository the check
  // does not apply (there is no commit path to protect).
  ignoreSplitMissing: string[];
  ignoreSplitApplicable: boolean;
  // The effective compaction policy line, shared with
  // `kubic config` — appended to the passing detail so doctor names the
  // reserve the lanes run with. Absent on older callers (tests).
  compactionSummary?: string;
}

export const CONFIG_DOCTOR_ID = 'config-load';

// The trust half of the detail, naming the exact provenance —
// the store file that records the grant, the env opt-in, or the remedy when
// the project layer has no accepted decision.
function projectTrustDetail(input: ConfigDoctorInput): string {
  const trust = input.projectTrust;
  if (trust === undefined) {
    return `project layer ${input.projectTrusted === true ? 'trusted' : 'not trusted'}`;
  }
  if (input.projectTrusted === true) {
    const via = [
      trust.decision === true ? `recorded in ${trust.storePath}` : undefined,
      trust.envTrust ? 'KUBIC_TRUST_PROJECT=1' : undefined,
      trust.storeError === undefined
        ? undefined
        : `store error: ${trust.storeError}`,
    ].filter((part): part is string => part !== undefined);
    return `project layer trusted${via.length === 0 ? '' : ` (${via.join(' + ')})`}`;
  }
  if (trust.storeError !== undefined) {
    return `project layer not trusted (${trust.storeError})`;
  }
  if (trust.decision === false) {
    return `project layer not trusted (declined in ${trust.storePath}; run 'kubic trust' to accept)`;
  }
  return "project layer not trusted (no decision recorded; run 'kubic trust' to accept, or set KUBIC_TRUST_PROJECT=1)";
}

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
      `${input.effectiveValues ?? 0} effective value(s); ${projectTrustDetail(input)}; ` +
      `runtime ignore split ${input.ignoreSplitApplicable ? 'complete' : 'not applicable (not a git repository)'}` +
      (input.compactionSummary === undefined
        ? ''
        : `; ${input.compactionSummary}`),
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
        ignoreSplitMissing: string[];
        ignoreSplitApplicable: boolean;
        projectTrust?: ConfigDoctorInput['projectTrust'];
        compactionSummary?: string;
      }
    | {
        error: string;
        ignoreSplitMissing: string[];
        ignoreSplitApplicable: boolean;
        projectTrust?: ConfigDoctorInput['projectTrust'];
      },
): ConfigDoctorInput {
  if ('error' in loaded) {
    return {
      effectiveValues: undefined,
      refusal: loaded.error,
      projectTrusted: undefined,
      projectTrust: loaded.projectTrust,
      unexplainedKeys: [],
      ignoreSplitMissing: loaded.ignoreSplitMissing,
      ignoreSplitApplicable: loaded.ignoreSplitApplicable,
    };
  }
  return {
    effectiveValues: loaded.values.length,
    refusal: undefined,
    projectTrusted: loaded.projectTrusted,
    projectTrust: loaded.projectTrust,
    // 'unknown' is the view's own word for "no effect row explains this key" —
    // one derivation, so doctor and `kubic config` agree.
    unexplainedKeys: loaded.values
      .filter((value) => value.disposition === 'unknown')
      .map((value) => value.key),
    ignoreSplitMissing: loaded.ignoreSplitMissing,
    ignoreSplitApplicable: loaded.ignoreSplitApplicable,
    ...(loaded.compactionSummary === undefined
      ? {}
      : { compactionSummary: loaded.compactionSummary }),
  };
}

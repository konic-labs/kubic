// The loaded configuration projected onto what each command consumes: the
// run and lane deps (`kubic run`, `kubic tui`, `kubic replay`), the approval
// and installed-policy deps, the skills and role layers, the request tuning,
// compaction and the retention bounds.

import type { LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type { PermissionClasses } from '@kubic/agent/permissions';
import type {
  ModelStreamTuning,
  StreamTuningTables,
} from '@kubic/agent/stream-options';
import type { JournalRetention } from '@kubic/exec/journal';
import type { ApprovalConfig } from '@kubic/host/approvals';
import type {
  ProjectTrustCheck,
  RuntimeConfig,
  RuntimeEscalation,
  RuntimeThinking,
  RuntimeVerify,
} from '@kubic/host/config';
import { CONFIG_LAYERS, checkModelStreamTuning } from '@kubic/host/config';
import type { RoleLayerInput, RoleLayerSpec } from '@kubic/host/roles';
import type { CliConfigResult } from './load.js';
import { projectTrustFor } from './load.js';

// The config `[approvals]` policy as the install consumes it: route,
// maxPendingMs, autoApprove, requireJustification and sessionScoped, projected
// ONCE here and spread into installPolicy by `kubic run`, `kubic tui`,
// replay and doctor's installed-policy line — so what doctor prints and what
// every lane enforces are one derivation. A refused config contributes
// nothing (the command fails closed first); absent means the documented
// defaults.
export function runtimeApprovalDeps(result: CliConfigResult): ApprovalConfig {
  const policy = result.runtime?.approvals.policy;
  if (policy === undefined) return {};
  return {
    route: policy.route,
    maxPendingMs: policy.maxPendingMs,
    autoApprove: [...policy.autoApprove],
    requireJustification: policy.requireJustification,
    sessionScoped: policy.sessionScoped,
  };
}

// The remaining `kubic run` projections: the permission classes
// the lane derives its tool allowlist from and the journal retention
// bound enforced on every append. A refused config contributes
// nothing here — the run itself fails closed before this matters.
export function runtimeRunDeps(result: CliConfigResult): {
  policyClasses?: PermissionClasses;
  journalRetention?: JournalRetention;
  // The declared out-of-scope paths, threaded to the
  // run/TUI lane's reconciliation. Undefined when config declares none — the
  // walk still skips `.git/`, `.kubic/` and `.gitignore` hits on its own.
  reconcileOutOfScope?: string[];
  // Where the classes came from, per the config layer's own
  // record. Threaded to the run path so the posture the lane installs and
  // the posture `doctor` prints carry the SAME source — a config
  // that sets only, say, `[journal]` still runs the documented defaults and
  // must not be reported as operator-configured classes.
  policySource: 'config' | 'default';
  // The config `[approvals]` policy the lane installs.
  approvals?: ApprovalConfig;
  // The `[verify]` gate commands the run executes in its
  // worktree after it settles. Undefined when none is configured — every
  // gate then stays unknown.
  verify?: RuntimeVerify;
} {
  const runtime = result.runtime;
  if (runtime === undefined) return { policySource: 'default' };
  const verifying = Object.keys(runtime.verify.commands).length > 0;
  return {
    ...(verifying
      ? {
          verify: {
            commands: { ...runtime.verify.commands },
            ...(runtime.verify.timeoutMs === undefined
              ? {}
              : { timeoutMs: runtime.verify.timeoutMs }),
          },
        }
      : {}),
    approvals: runtimeApprovalDeps(result),
    policyClasses: { ...runtime.permissions.classes },
    policySource:
      runtime.permissions.source === 'defaults' ? 'default' : 'config',
    journalRetention:
      runtime.journal.maxAgeMs === undefined &&
      runtime.journal.maxBytes === undefined
        ? {}
        : {
            ...(runtime.journal.maxAgeMs === undefined
              ? {}
              : { maxAgeMs: runtime.journal.maxAgeMs }),
            ...(runtime.journal.maxBytes === undefined
              ? {}
              : { maxBytes: runtime.journal.maxBytes }),
          },
    ...(runtime.journal.outOfScope === undefined
      ? {}
      : { reconcileOutOfScope: [...runtime.journal.outOfScope] }),
  };
}

// The shared lane projections: the agent id the lane and
// its journal attribution carry, and the config-sourced role layers the
// `--role` resolution merges under the role document. ONE projection with
// two one-line consumers — `kubic run` (run/command.ts) and `kubic tui`
// (tui/boot.ts) — so both entry points name the lane and layer the roles
// identically. Absent means the shipped behaviour: agent id 'root', no
// layers. adds the effective thinking level with its source, which
// the lane resolves against the session's record and the role default.
export function runtimeLaneDeps(result: CliConfigResult): {
  agentId?: string;
  roles?: {
    layers: RoleLayerInput[];
    trustProject: ProjectTrustCheck;
    homeDir?: string;
  };
  thinking?: RuntimeThinking;
  /** The merged `[model]` ladder — the lane climbs
   * the role's own rungs first when the role names any. */
  escalate?: RuntimeEscalation;
} {
  const runtime = result.runtime;
  if (runtime === undefined) return {};
  const agentId = runtime.config.agent?.name;
  const layers = roleLayersFromConfig(runtime);
  // The repo role documents resolve under the
  // same per-path trust check as the project models.json and skills — so
  // `kubic run --role` and `kubic tui --role` load an untrusted root's
  // documents never. The check folds the KUBIC_TRUST_PROJECT opt-in in.
  const trustProject = projectTrustFor(result);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    // Always present (even with no layers): the trust check travels on `roles`
    // so callers never default to an untrusted load. The home directory
    // travels with it, so both lanes layer the global `~/.kubic/roles` under
    // the project documents — absent (an empty home, tests and embeddings)
    // means no global source.
    roles: {
      layers,
      trustProject,
      ...(result.trust.home === '' ? {} : { homeDir: result.trust.home }),
    },
    ...(runtime.thinking === undefined
      ? {}
      : { thinking: { ...runtime.thinking } }),
    // No ladder, no field: escalation stays opt-in — the
    // lane climbs nothing it was never configured with.
    ...(runtime.escalate === undefined
      ? {}
      : {
          escalate: {
            steps: [...runtime.escalate.steps],
            maxEscalations: runtime.escalate.maxEscalations,
          },
        }),
  };
}

// The settings `skills` projection: the merged
// top-level `skills` array, entries already resolved against their
// declaring file's directory at load. Project-layer entries apply only
// when the project root is trusted — the load refuses an untrusted
// project file before reading, so a project-sourced list reaching here
// is trusted by construction; the check is re-applied all the same, so a
// hand-built runtime (tests, embeddings) never sneaks one past. Always
// returns the key (possibly empty) so callers spread unconditionally.
export function runtimeSkillsDeps(result: CliConfigResult): {
  settingsSkills: string[];
} {
  const runtime = result.runtime;
  const skills = runtime?.config.skills ?? [];
  if (skills.length === 0) return { settingsSkills: [] };
  if (runtime?.sources.skills === 'project') {
    const root = result.projectRoot;
    if (root === undefined || !projectTrustFor(result)(root)) {
      return { settingsSkills: [] };
    }
  }
  return { settingsSkills: [...skills] };
}

// The config `[roles.<name>]` table as resolver layer inputs:
// one input per config layer that actually set a leaf, so the resolver's
// first-layer-wins merge sees exactly the provenance the config load
// recorded — `roles.implementer.model` from the project layer never
// masquerades as an enterprise value. The layer order is CONFIG_LAYERS'.
/** @internal */
export function roleLayersFromConfig(runtime: RuntimeConfig): RoleLayerInput[] {
  const roles = runtime.config.roles;
  if (roles === undefined) return [];
  const layers: RoleLayerInput[] = [];
  for (const layer of CONFIG_LAYERS) {
    const specs: Record<string, RoleLayerSpec> = {};
    for (const [name, entry] of Object.entries(roles)) {
      const spec: RoleLayerSpec = {};
      if (
        entry.tools !== undefined &&
        runtime.sources[`roles.${name}.tools`] === layer
      ) {
        spec.tools = [...entry.tools];
      }
      // The layer's approval obligations travel like
      // `tools` — the resolver unions them with the document's list.
      if (
        entry.requires !== undefined &&
        runtime.sources[`roles.${name}.requires`] === layer
      ) {
        spec.requires = [...entry.requires];
      }
      if (
        entry.model !== undefined &&
        runtime.sources[`roles.${name}.model`] === layer
      ) {
        spec.model = entry.model;
      }
      // The allowed set rides the same provenance:
      // the winning list travels on the layer that set it, copied so
      // the resolver owns its merge input.
      if (
        entry.models !== undefined &&
        runtime.sources[`roles.${name}.models`] === layer
      ) {
        spec.models = entry.models.map((modelEntry) => ({ ...modelEntry }));
      }
      // The ladder rides the same provenance: the
      // winning rungs travel on the layer that set them, copied so the
      // resolver owns its merge input.
      if (
        entry.escalate !== undefined &&
        runtime.sources[`roles.${name}.escalate`] === layer
      ) {
        spec.escalate = [...entry.escalate];
      }
      if (
        entry.thinking !== undefined &&
        runtime.sources[`roles.${name}.thinking`] === layer
      ) {
        spec.thinking = entry.thinking;
      }
      if (Object.keys(spec).length > 0) specs[name] = spec;
    }
    if (Object.keys(specs).length > 0) layers.push({ layer, roles: specs });
  }
  return layers;
}

// Request options: the merged `[model]` tuning plus
// every `[roles.<name>]` table that sets a key, re-checked here so the
// programmatic session/agent layers (which bypass the TOML parser) cannot
// hand the lane a malformed value. Undefined when nothing is tuned — the
// run sites then omit `settings.stream` and the provider defaults stand.
// The run sites resolve the tables against the run's role with
// `resolveStreamOptions`, so each lane (or agent) carries its own
// role's tuning on its own harness.
export function runtimeStreamTuning(
  result: CliConfigResult,
): StreamTuningTables | undefined {
  const runtime = result.runtime;
  if (runtime === undefined) return undefined;
  const toTuning = (
    record: Record<string, unknown>,
    keyPath: string,
  ): ModelStreamTuning => {
    const { cacheRetention, ...rest } = checkModelStreamTuning(record, keyPath);
    return {
      ...rest,
      // Validated one line above against the same three literals Pi
      // names, so the narrowing is exact, never a guess.
      ...(cacheRetention === undefined
        ? {}
        : {
            cacheRetention:
              cacheRetention as ModelStreamTuning['cacheRetention'],
          }),
    };
  };
  const model = toTuning({ ...runtime.config.model }, 'model');
  const roles: Record<string, ModelStreamTuning> = {};
  for (const [name, spec] of Object.entries(runtime.config.roles ?? {})) {
    const tuning = toTuning({ ...spec }, `roles.${name}`);
    if (Object.keys(tuning).length > 0) roles[name] = tuning;
  }
  if (Object.keys(model).length === 0 && Object.keys(roles).length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(model).length === 0 ? {} : { model }),
    ...(Object.keys(roles).length === 0 ? {} : { roles }),
  };
}

// `kubic sessions prune`'s default keep-window: the parsed
// `session.retentionDays` leaf — undefined when config sets none (or the
// load was refused), so prune demands an explicit --keep-days instead of
// inventing a window (fail-closed; deletion stays explicit). 0 is a
// real value here: it means retention off, and prune reports it as such.
export function sessionRetentionDays(
  result: CliConfigResult,
): number | undefined {
  return result.runtime?.config.session?.retentionDays;
}

// `kubic journal prune`'s default keep-window: the resolved
// `journal.retentionDays` of the runtime load, so `KUBIC_JOURNAL_RETENTION_DAYS`
// counts (the env layer beats the file layers, as everywhere else). Undefined
// when nothing sets it or the load was refused, so prune demands --keep-days.
// 0 means retention off.
export function journalRetentionDays(
  result: CliConfigResult,
): number | undefined {
  return result.runtime?.journal.retentionDays;
}

// The `[agent] systemPromptFile` contents `kubic run` boots with: the file text
// the runtime read at load. Undefined when no layer declares the key (or the
// load was refused) — the lane assembles its prompt unchanged.
export function runtimeSystemPromptSection(
  result: CliConfigResult,
): string | undefined {
  return result.runtime?.systemPromptFile?.contents;
}

// The lane compaction options `kubic run` boots with: the
// configured `[session]` compaction keys over the SAME load every other
// consumer uses. Undefined when config sets none (or the load was refused),
// so the lane defaults apply — never an invented value.
export function runtimeCompactionDeps(
  result: CliConfigResult,
): LaneCompactionOptions | undefined {
  const compaction = result.runtime?.compaction;
  if (compaction === undefined) return undefined;
  const { enabled, reserveTokens, keepRecentTokens } = compaction;
  if (
    enabled === undefined &&
    reserveTokens === undefined &&
    keepRecentTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(reserveTokens === undefined ? {} : { reserveTokens }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
  };
}

// Installed-policy projection: what `doctor` reports and what the
// `run`/`tui` installs read, over the SAME config load the run path uses.
//
// `source` is the honesty switch, taken from the config layer's own record
// (runtime.permissions.source) rather than from the shape of the object: a
// config-less install yields DEFAULT_PERMISSIONS through validateClasses, so
// "classes are present" does NOT mean "the operator configured them". Only a
// real layer (file/env/cli) makes it 'config'.
export function installedPolicyDeps(result: CliConfigResult): {
  classes?: PermissionClasses;
  source: 'config' | 'default';
} & ApprovalConfig {
  const { policyClasses, policySource } = runtimeRunDeps(result);
  return {
    ...(policySource === 'config' && policyClasses !== undefined
      ? { classes: policyClasses }
      : {}),
    source: policySource,
    // The approval half of the same projection, so doctor's
    // `policy:installed` line and the lane read one derivation.
    ...runtimeApprovalDeps(result),
  };
}

// The projection `doctor` and the `tui` path read, over the SAME config load
// `kubic run` uses. Absent config → absent classes → installPolicy's
// documented DEFAULT_PERMISSIONS, which is exactly what a config-less run installs,
// so doctor's line and the lane's posture are the same object.
export function installedPolicyClasses(result: CliConfigResult): {
  classes?: PermissionClasses;
} {
  const { classes } = installedPolicyDeps(result);
  return classes === undefined ? {} : { classes };
}

// The runtime configuration a command runs on: the merged config with the
// projections each consumer reads, and where every value came from.

import type { PermissionClasses } from '@kubic/agent/permissions';
import type { FileBridge } from '@kubic/exec/file-bridge';
import type { validatePolicy } from '../approvals/index.js';
import type { EffectivePolicy } from '../policy/index.js';
import type {
  ConfigLayer,
  KubicConfig,
  VERIFY_COMMAND_KEYS,
} from './config.js';
import type { ProjectRestriction } from './project-restriction.js';

// Where an effective value came from: one of the six config layers, the
// documented environment overrides, the explicit CLI flag, or the product's
// own default when nothing set it.
export type ConfigValueSource = ConfigLayer | 'env' | 'cli' | 'defaults';

export interface RuntimeModelSelection {
  provider: string;
  id: string;
  thinking?: string;
}

// The effective thinking level with where it came from.
// `cli`/`env` sources are per-run overrides that beat a session's persisted
// level; a file-layer source is the config default, which a persisted
// session level and a role default both beat (resolved at lane boot).
export interface RuntimeThinking {
  level: string;
  source: ConfigValueSource;
}

// A cli/env model pin the frozen enterprise `[model]` overrode: reported
// instead of being dropped silently, so `kubic run --model x` against an
// enterprise pin says it ran the pin, not `x`.
export interface ModelPinOverride {
  // The input that carried the ignored pin: `--model` (cli layer) or
  // `KUBIC_MODEL` (env layer).
  source: 'cli' | 'env';
  // The ignored `provider/id`.
  requested: string;
  // The enterprise `provider/id` that ran instead.
  pinned: string;
}

export interface RuntimeApprovals {
  policy: ReturnType<typeof validatePolicy>;
  source: ConfigValueSource;
}

export interface RuntimePermissions {
  classes: PermissionClasses;
  source: ConfigValueSource;
}

export interface RuntimeJournal {
  // Undefined means "no age bound configured" — never an invented default.
  retentionDays?: number;
  maxAgeMs?: number;
  // The configured byte bound; undefined means the store's own
  // default applies (100 MiB), never an invented value here.
  maxBytes?: number;
  /**
   * Out-of-scope paths: undefined means none declared — the
   * Walk still skips `.git/`, `.kubic/` and `.gitignore` hits on its
   * own. Declared entries exclude the path itself and everything under it.
   * The leaf's own layer lives in `sources['journal.outOfScope']`; `source`
   * below is the retention bound's origin.
   */
  outOfScope?: string[];
  source: ConfigValueSource;
}

export interface RuntimeSystemPrompt {
  // The resolved path (what `kubic config` reports) and the contents the
  // lane boots append to the assembled system prompt. Read once, at load,
  // through the file bridge — a missing or unreadable file is a named
  // ConfigError, never a silent skip.
  path: string;
  contents: string;
  // The layer that declared it (global paths are always allowed; the
  // project layer additionally requires trust and containment, enforced
  // at load).
  source: ConfigValueSource;
}

export interface RuntimeCompaction {
  // Undefined means "not configured" — the lane defaults apply (automatic
  // compaction, the default reserve, the default recent window), never an
  // invented value here.
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  // The highest-precedence layer that set a key, or 'defaults' when none
  // is set.
  source: ConfigValueSource;
}

// The merged `[model]` escalation ladder: steps plus
// the per-run bound, projected once per config load.
export interface RuntimeEscalation {
  steps: string[];
  maxEscalations: number;
}

export interface ConfigLayerReport {
  layer: ConfigLayer;
  path: string | undefined;
  present: boolean;
  trusted: boolean;
}

export interface RuntimeConfigInputs {
  // `realPath` (optional) lets the project layer's prompt file be contained
  // through symlinks too.
  bridge: Pick<FileBridge, 'exists' | 'readTextFile' | 'realPath'>;
  home: string;
  cwd: string;
  // The project root the project layer resolves at —
  // the nearest ancestor holding `.kubic/` (or the git top level). Absent
  // means the load resolves it from the cwd itself (findProjectRoot), so
  // a run from a subdirectory reads the same committed config as one from
  // the root instead of silently dropping to defaults.
  projectRoot?: string;
  enterprisePath?: string;
  productPath?: string;
  env?: Record<string, string | undefined>;
  // Trust gate for the project layer. An explicit true is the
  // caller's accepted trust prompt; KUBIC_TRUST_PROJECT=1 also opts in.
  projectTrusted?: boolean;
  // The project had a grant, but its trust-relevant files changed since: the
  // refusal says so instead of reading as a never-trusted project.
  projectTrustChanged?: boolean;
  cli?: { model?: RuntimeModelSelection; thinking?: string };
  // Session/agent layers arrive programmatically, never as files.
  session?: KubicConfig;
  agent?: KubicConfig;
}

// Gate commands: what `kubic run` verifies after each
// settled run. Empty `commands` means nothing is verified — every gate
// stays unknown, never a guessed pass.
export interface RuntimeVerify {
  commands: Partial<Record<(typeof VERIFY_COMMAND_KEYS)[number], string>>;
  timeoutMs?: number;
}

// `[run]`: the headless run bounds, used when `--timeout` / `--max-turns`
// are not given.
export interface RuntimeRun {
  timeoutMs?: number;
  maxTurns?: number;
}

export interface RuntimeConfig {
  config: KubicConfig;
  /**
   * Enterprise policy, resolved ONCE per process from the
   * per-layer `[policy]` sections (enterprise > product > … > agent) — the
   * same merge the config layers use, with deny accumulation and layer
   * provenance. Empty when no layer declares `[policy]`.
   */
  policy: EffectivePolicy;
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  // Undefined when nothing set a level: the lane then boots at the session's
  // persisted level, a role default, or Pi's 'off'.
  thinking: RuntimeThinking | undefined;
  // The merged `[model]` escalation ladder: the steps
  // plus the bound (defaulting to the ladder length — the ladder itself
  // bounds). Undefined when no layer named rungs: escalation is opt-in.
  // A role's own ladder wins per run at the lane, not here.
  escalate: RuntimeEscalation | undefined;
  approvals: RuntimeApprovals;
  permissions: RuntimePermissions;
  journal: RuntimeJournal;
  compaction: RuntimeCompaction;
  // Undefined when no layer declares `[agent] systemPromptFile` — the
  // lane assembles its prompt unchanged.
  systemPromptFile?: RuntimeSystemPrompt;
  verify: RuntimeVerify;
  run: RuntimeRun;
  projectTrusted: boolean;
  // `[policy] project_policy = "restricted"` from a layer above the project.
  projectRestriction?: ProjectRestriction;
  overriddenAttempts: string[];
  // The cli/env model pins a frozen enterprise `[model]` overrode (also named
  // in `overriddenAttempts`); empty when nothing was overridden — the same pin
  // named twice, no freeze, or no cli/env pin.
  modelPinOverrides: ModelPinOverride[];
  layers: ConfigLayerReport[];
  // Leaf path → source, for every key the effective view reports.
  sources: Record<string, ConfigValueSource>;
}

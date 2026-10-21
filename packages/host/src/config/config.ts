// Layered TOML config with enterprise supremacy.
// Roots: /etc/kubic/ (enterprise, product), ~/.kubic/ (global) and .kubic/
// (project-local, trust-gated).
// Precedence: Enterprise > Product > Global > Project > Session > Agent — a
// lower layer can never override a key set by a higher layer
// (enterprise keys are frozen against every override attempt).
// Canonical shape: agent/model/thinking, approvals (ask-user +
// deny-on-timeout), journal retention, per-role model/tools, ui, session
// store + retention. Secrets never appear here (see ../secret-refs/).
// The files are parsed by toml-parse.ts.
//
// File access arrives as a FileBridge (exec-owned I/O confinement) — this
// module never touches node:fs directly. Never imports agent impl.

import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RoleModelEntry } from './checks.js';
import { checkKeys, checkNoUnknown, isRecord } from './checks.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import type { ConfigKey } from './schema.js';
import { CONFIG_SECTIONS } from './schema.js';
import { assertNoMcpConfig, McpUnsupportedError } from './stances.js';
import { assertSafePathKey, parseTomlDocument } from './toml-parse.js';

export const CONFIG_LAYERS = [
  'enterprise',
  'product',
  'global',
  'project',
  'session',
  'agent',
] as const;

export type ConfigLayer = (typeof CONFIG_LAYERS)[number];

interface AgentConfig {
  name?: string;
  // System prompt augmentation: a
  // path whose contents the runtime appends to the assembled lane prompt.
  // Resolved against the declaring config file's directory (`~` expands to
  // the home directory); the project layer additionally requires trust
  // and containment in the project root, enforced at load.
  systemPromptFile?: string;
  // Whether the trusted project's AGENTS.md files reach the prompt.
  projectInstructions?: boolean;
}

export interface ModelConfig {
  provider?: string;
  id?: string;
  thinking?: string;
  // Request options: per-provider request tuning Pi
  // reads at every use (timeoutMs, maxRetries, maxRetryDelayMs,
  // cacheRetention). Absent means the provider default; a `[roles.<n>]`
  // table overrides each key it sets.
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  cacheRetention?: string;
  /** Escalation ladder rungs: ordered concrete refs. */
  escalate?: string[];
  /** Escalation bound: climbs allowed per run. */
  maxEscalations?: number;
}

export interface ApprovalsConfig {
  route?: 'ask-user' | 'deny';
  maxPendingMs?: number;
  autoApprove?: string[];
  sessionScoped?: boolean;
  requireJustification?: boolean;
}

// Permission classes as a config section: the values are
// validated against the agents-owned level vocabulary (validateClasses) when
// the runtime projection consumes them — never re-listed here.
interface PermissionsConfig {
  filesystem?: string | boolean;
  shell?: string | boolean;
  network?: string | boolean;
  git?: string | boolean;
  credentials?: string | boolean;
}

interface JournalConfig {
  retentionDays?: number;
  /**
   * The journal's byte bound: the WHOLE store — `index.jsonl`
   * plus the blobs it references — is pruned on every append to stay under
   * this. Content addressing dedupes blobs, so without the index in the
   * bound a file toggling between two contents grew the journal without
   * limit. Unset ⇒ `DEFAULT_JOURNAL_MAX_BYTES` (100 MiB).
   */
  maxBytes?: number;
  /**
   * Out-of-scope paths: workspace-relative paths excluded
   * from the baseline and the end-of-run sweep. An entry excludes the
   * path itself and everything under it — `dist` ⇒ `dist`, `dist/a.js`,
   * `dist/sub/b.js`. Plain paths only (patterns belong in `.gitignore`);
   * `.git/` and `.kubic/` stay hard-skipped before any config.
   */
  outOfScope?: string[];
}

interface RoleConfig {
  model?: string;
  // Request options: per-key overrides of the `[model]`
  // tuning for lanes booted as this role.
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  cacheRetention?: string;
  tools?: string[];
  // Tool names that always require approval under
  // this role — forwarded to the resolver layers like `tools`.
  requires?: string[];
  // Per-role thinking default: one of
  // THINKING_LEVELS, below the session-persisted level and above
  // `[model].thinking` in the lane's resolution.
  thinking?: string;
  // The per-role allowed model set: normalized
  // entries (`provider/id` or `provider/*`, optional per-entry
  // thinking). Absent or empty means all models.
  models?: RoleModelEntry[];
  // The per-role escalation ladder: ordered concrete
  // rungs, winning over the `[model]` ladder for this role when set.
  escalate?: string[];
}

interface UiConfig {
  theme?: string;
  statusBar?: boolean;
}

export interface SessionConfig {
  store?: string;
  dir?: string;
  // Retention for session state: the default keep-window for
  // `kubic sessions prune`, in days. Unset means "off" — prune then
  // demands an explicit --keep-days rather than inventing a window; 0 also
  // means off (retention disabled, never "everything is old").
  retentionDays?: number;
  // Compaction policy: whether threshold
  // compaction runs, the reserved-room tokens and the verbatim recent
  // window the lane compacts under. Unset means the lane defaults
  // (automatic, 16384 reserved, 20000 kept recent).
  autoCompact?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

// Gate commands: each runs as `sh -c <command>` in the
// run's worktree after the run settles, and its exit status becomes the
// trajectory's `signal:<gate>` label (0 = pass). An absent gate stays
// `unknown`. timeoutMs bounds each command (a timeout is a fail).
export interface VerifyConfig {
  tests?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
  timeoutMs?: number;
}

// `[run]`: the headless run bounds a config sets when the flags do not.
interface RunConfig {
  timeoutMs?: number;
  maxTurns?: number;
}

// `[managed]`: the signed remote policy a managed config points at. Read only
// from the managed (enterprise) config.
interface ManagedConfig {
  url?: string;
  refreshHours?: number;
}

// The `[verify]` gate commands: the section's command keys.
type VerifyCommandKey = Extract<
  SchemaSection<'verify'>['keys'][number],
  { check: 'command' }
>['name'];
export const VERIFY_COMMAND_KEYS: readonly VerifyCommandKey[] = sectionNamed(
  'verify',
)
  .keys.filter((key) => key.check === 'command')
  .map((key) => key.name as VerifyCommandKey);

// Enterprise Policy: the documented flat `[policy]` surface.
// The parser accepts exactly these keys and normalizes them for the policy
// engine's own vocabulary (`layerPolicyFromConfig` in host/policy). Unknown
// keys fail closed and are named; a value the engine has no enforceable leaf
// for is still parsed and carried (`dataPolicy`, `loggingPolicy`) so doctor
// can report it rather than silently dropping it.
interface PolicyConfig {
  allowedModels?: string[];
  allowedProviders?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  // 'proxy' is the spelling of the engine's 'allowlist' mode; the engine
  // mode names are accepted too so the two vocabularies meet in one place.
  networkPolicy?: string;
  allowedDomains?: string[];
  // 'workspace-only' is the spelling of the engine's 'workspace-write'.
  filesystemPolicy?: string;
  dataPolicy?: string;
  loggingPolicy?: string;
  // 'open' (default) or 'restricted': what a repository may set for itself.
  projectPolicy?: string;
  // Spend caps in US dollars; the lowest any layer sets wins.
  maxRunCostUsd?: number;
  maxDailyCostUsd?: number;
}

// `[cost]`: the team new sessions are billed to.
interface CostConfig {
  team?: string;
}

// `[[audit]]` (parsed here; built in audit/sinks.ts).
export interface AuditTableConfig {
  sink: string;
  level?: string;
  target?: string;
  // Docs promise a name or a number 0–23.
  facility?: string | number;
  // PEM certificates a TLS syslog, https or otlp collector is checked against.
  ca?: string;
  // The environment variable holding a bearer token for https and otlp.
  tokenEnv?: string;
}

export interface KubicConfig {
  agent?: AgentConfig;
  model?: ModelConfig;
  approvals?: ApprovalsConfig;
  permissions?: PermissionsConfig;
  journal?: JournalConfig;
  roles?: Record<string, RoleConfig>;
  // A top-level `skills` array of files or
  // directories — NOT a `[skills]` section. Entries are stored as written
  // (relative stays relative); the config LOAD resolves each layer's
  // entries against that layer's file directory, so a project config's
  // relative entry anchors at the project, never the invoking cwd.
  skills?: string[];
  ui?: UiConfig;
  session?: SessionConfig;
  verify?: VerifyConfig;
  run?: RunConfig;
  cost?: CostConfig;
  managed?: ManagedConfig;
  policy?: PolicyConfig;
  audit?: AuditTableConfig[];
}

// The parsed type of each section. Its fields are the schema's keys
// (schema.ts); a key added to one and not the other fails the compile-time
// check below.
interface SectionTypes {
  agent: AgentConfig;
  model: ModelConfig;
  approvals: ApprovalsConfig;
  permissions: PermissionsConfig;
  journal: JournalConfig;
  roles: RoleConfig;
  ui: UiConfig;
  session: SessionConfig;
  verify: VerifyConfig;
  run: RunConfig;
  cost: CostConfig;
  managed: ManagedConfig;
  policy: PolicyConfig;
  audit: AuditTableConfig;
}
type SchemaSection<N> = Extract<(typeof CONFIG_SECTIONS)[number], { name: N }>;
type FieldOf<K> = K extends { field: infer F }
  ? F
  : K extends { name: infer N }
    ? N
    : never;
type SchemaFields<N> = FieldOf<SchemaSection<N>['keys'][number]>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SectionsMatch = {
  [N in keyof SectionTypes]: Same<SchemaFields<N>, keyof SectionTypes[N]>;
};
const _sectionsMatchTheirTypes: SectionsMatch = {
  agent: true,
  model: true,
  approvals: true,
  permissions: true,
  journal: true,
  roles: true,
  ui: true,
  session: true,
  verify: true,
  run: true,
  cost: true,
  managed: true,
  policy: true,
  audit: true,
};

type Section = (typeof CONFIG_SECTIONS)[number];

function sectionNamed(name: string): Section {
  const section = CONFIG_SECTIONS.find((candidate) => candidate.name === name);
  if (section === undefined) throw new Error(`no config section '${name}'`);
  return section;
}

function keyNames(section: Section): ReadonlySet<string> {
  return new Set(section.keys.map((key) => key.name));
}

function keysNamed(
  section: Section,
  names: readonly string[],
): readonly ConfigKey[] {
  return section.keys.filter((key) => names.includes(key.name));
}

// The top-level names a config file may hold: the sections, and the keys
// that are not a section (`skills`).
const KNOWN_TOP_LEVEL = new Set<string>(
  CONFIG_SECTIONS.map((section) => section.name),
);

// One section of a parsed TOML document.
function parseSection(section: Section, raw: unknown): unknown {
  const name = section.name;
  switch (section.shape) {
    case 'value': {
      const key: ConfigKey = section.keys[0];
      return checkKeys([key], { [name]: raw }, name)[key.name];
    }
    case 'table': {
      if (!isRecord(raw)) throw new ConfigError(`'[${name}]' must be a table`);
      checkNoUnknown(raw, keyNames(section), name);
      const parsed = checkKeys(section.keys, raw, name);
      if ('omitEmpty' in section && Object.keys(parsed).length === 0) {
        return undefined;
      }
      return parsed;
    }
    case 'tables': {
      if (!isRecord(raw)) throw new ConfigError(`'[${name}]' must be a table`);
      const parsed: Record<string, unknown> = {};
      for (const [entry, spec] of Object.entries(raw)) {
        const path = `${name}.${entry}`;
        if (!isRecord(spec)) {
          throw new ConfigError(`'[${path}]' must be a table`);
        }
        checkNoUnknown(spec, keyNames(section), path);
        parsed[entry] = checkKeys(section.keys, spec, path);
      }
      return parsed;
    }
    case 'array': {
      if (!Array.isArray(raw)) {
        throw new ConfigError(
          `'[[${name}]]' must be an array of tables (use '[[${name}]]', not '[${name}]')`,
        );
      }
      return raw.map((entry, index) => {
        const path = `${name}[${index + 1}]`;
        if (!isRecord(entry))
          throw new ConfigError(`'${path}' must be a table`);
        checkNoUnknown(entry, keyNames(section), path);
        return checkKeys(section.keys, entry, path);
      });
    }
  }
}

function toKubicConfig(raw: Record<string, unknown>): KubicConfig {
  assertNoMcpConfig(raw);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      throw new ConfigError(`unknown section '[${key}]'`);
    }
  }
  const config: Record<string, unknown> = {};
  for (const section of CONFIG_SECTIONS) {
    const value = raw[section.name];
    if (value === undefined) continue;
    const parsed = parseSection(section, value);
    if (parsed !== undefined) config[section.name] = parsed;
  }
  return config as KubicConfig;
}

// The request options `[model]` and `[roles.<name>]` share, checked for a
// programmatic layer (which never passes through the parser).
export function checkModelStreamTuning(
  record: Record<string, unknown>,
  keyPath: string,
): Pick<
  ModelConfig,
  'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention'
> {
  return checkKeys(
    keysNamed(sectionNamed('model'), [
      'timeoutMs',
      'maxRetries',
      'maxRetryDelayMs',
      'cacheRetention',
    ]),
    record,
    keyPath,
  );
}

// The session compaction policy, checked for a programmatic layer. A
// non-boolean switch and a non-positive-safe-integer token count are
// refused by key name — fail closed, never a half-applied policy.
export function checkSessionCompaction(
  session: Record<string, unknown>,
  keyPath: string,
): Pick<SessionConfig, 'autoCompact' | 'reserveTokens' | 'keepRecentTokens'> {
  return checkKeys(
    keysNamed(sectionNamed('session'), [
      'autoCompact',
      'reserveTokens',
      'keepRecentTokens',
    ]),
    session,
    keyPath,
  );
}

// `[verify]`, checked for a programmatic layer: a blank or non-string
// command and a non-positive or fractional timeout are refused by name.
export function checkVerifyConfig(
  verify: Record<string, unknown>,
  keyPath: string,
): VerifyConfig {
  const section = sectionNamed('verify');
  checkNoUnknown(verify, keyNames(section), keyPath);
  return checkKeys(section.keys, verify, keyPath);
}

// `[run]`, checked for a programmatic layer the same way a file layer is.
export function checkRunConfig(
  run: Record<string, unknown>,
  keyPath: string,
): RunConfig {
  const section = sectionNamed('run');
  checkNoUnknown(run, keyNames(section), keyPath);
  return checkKeys(section.keys, run, keyPath);
}

// Resolve one layer's `skills` entries against the
// directory of the config FILE that declared them — never the invoking
// cwd. Absolute entries pass through; `~` and env vars are NOT expanded
// (a config file is not a shell). Returns a copy; the input is untouched.
export function resolveConfigSkills(
  config: KubicConfig,
  filePath: string,
): KubicConfig {
  if (config.skills === undefined) return config;
  const dir = dirname(filePath);
  return {
    ...config,
    skills: config.skills.map((entry) =>
      isAbsolute(entry) ? entry : resolve(dir, entry),
    ),
  };
}

export function parseTomlConfig(text: string): KubicConfig {
  return toKubicConfig(parseTomlDocument(text));
}

export interface LayerInput {
  layer: ConfigLayer;
  config: KubicConfig;
  // Project-local config is trust-gated: callers must pass trusted: true
  // only after the project was trusted (`kubic trust`, the TUI prompt, or
  // KUBIC_TRUST_PROJECT=1 for the invocation).
  trusted?: boolean;
}

export interface MergeResult {
  config: KubicConfig;
  // Leaf paths where a lower layer attempted to override a higher layer
  // (first wins; attempts are reported, never applied).
  overriddenAttempts: string[];
}

function flattenRecord(
  value: Record<string, unknown>,
  prefix: string,
  out: Map<string, unknown>,
): void {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isRecord(entry)) flattenRecord(entry, path, out);
    else out.set(path, entry);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function unflatten(leaves: Map<string, unknown>): KubicConfig {
  const root: Record<string, unknown> = {};
  for (const [path, value] of leaves) {
    const parts = path.split('.');
    for (const part of parts) assertSafePathKey(part, `path '${path}'`);
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i] as string;
      const next = node[key];
      if (!isRecord(next)) {
        const fresh: Record<string, unknown> = {};
        node[key] = fresh;
        node = fresh;
      } else {
        node = next;
      }
    }
    node[parts[parts.length - 1] as string] = value;
  }
  return root as KubicConfig;
}

export function mergeLayered(inputs: LayerInput[]): MergeResult {
  for (const input of inputs) {
    if (
      input.layer === 'project' &&
      input.trusted !== true &&
      Object.keys(input.config).length > 0
    ) {
      throw new ProjectUntrustedError(
        "project-local config refused: the project layer is untrusted — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation",
      );
    }
  }
  const ordered = [...inputs].sort(
    (a, b) => CONFIG_LAYERS.indexOf(a.layer) - CONFIG_LAYERS.indexOf(b.layer),
  );
  const leaves = new Map<string, unknown>();
  const overriddenAttempts: string[] = [];
  for (const input of ordered) {
    const flat = new Map<string, unknown>();
    flattenRecord(input.config as Record<string, unknown>, '', flat);
    for (const [path, value] of flat) {
      if (!leaves.has(path)) {
        leaves.set(path, value);
      } else if (!sameValue(leaves.get(path), value)) {
        overriddenAttempts.push(path);
      }
    }
  }
  return { config: unflatten(leaves), overriddenAttempts };
}

export function defaultLayerPaths(args: {
  home: string;
  projectRoot: string;
  enterprisePath?: string;
  productPath?: string;
}): Record<ConfigLayer, string | undefined> {
  return {
    enterprise: args.enterprisePath ?? join('/etc', 'kubic', 'config.toml'),
    product: args.productPath ?? join('/etc', 'kubic', 'product.toml'),
    global: join(args.home, '.kubic', 'config.toml'),
    project: join(args.projectRoot, '.kubic', 'config.toml'),
    // Session + agent layers are supplied programmatically (never files).
    session: undefined,
    agent: undefined,
  };
}

function withLayerContext(layer: ConfigLayer, error: unknown): never {
  if (error instanceof McpUnsupportedError) {
    throw new McpUnsupportedError(`layer '${layer}': ${error.message}`);
  }
  if (error instanceof ConfigError) {
    throw new ConfigError(`layer '${layer}': ${error.message}`);
  }
  throw new ConfigError(
    `layer '${layer}': ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Parse one layer's text with the layer named on every failure:
// the runtime load parses layers itself so it can record which layer set
// which leaf, and a failure must still name the offending layer.
export function parseLayerConfig(
  layer: ConfigLayer,
  text: string,
): KubicConfig {
  try {
    return parseTomlConfig(text);
  } catch (error) {
    withLayerContext(layer, error);
  }
}

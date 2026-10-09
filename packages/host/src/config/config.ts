// Layered TOML config with enterprise supremacy.
// Roots: ~/.kubic/ (global) + .kubic/ (project-local, trust-gated).
// Precedence: Enterprise > Global > Project > Workspace > Session > Agent —
// a lower layer can never override a key set by a higher layer (enterprise
// keys are frozen against every override attempt).
// Canonical shape: agent/model/thinking, approvals (ask-user +
// deny-on-timeout), journal retention, per-role model/tools, ui, session
// store + retention. Secrets never appear here (see secrets.ts).
//
// File access arrives as a FileBridge (exec-owned I/O confinement) — this
// module never touches node:fs directly. Never imports agent impl.

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RUNTIME_EXCLUDE_ENTRIES } from '@kubic/exec/runtime-exclude';
import {
  checkKeys,
  checkNoUnknown,
  isRecord,
  type RoleModelEntry,
} from './checks.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import { CONFIG_SECTIONS, type ConfigKey } from './schema.js';
import { assertNoMcpConfig, McpUnsupportedError } from './stances.js';

export const CONFIG_LAYERS = [
  'enterprise',
  'product',
  'global',
  'project',
  'workspace',
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
}

// `[[audit]]` (parsed here; built in audit/sinks.ts).
export interface AuditTableConfig {
  sink: string;
  level?: string;
  target?: string;
  // Docs promise a name or a number 0–23.
  facility?: string | number;
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
  policy?: PolicyConfig;
  audit?: AuditTableConfig[];
}

function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitEquals(line: string, lineNo: number): [string, string] {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '=') {
      return [line.slice(0, i), line.slice(i + 1)];
    }
  }
  throw new ConfigError(`line ${lineNo}: expected key = value`);
}

function splitTopLevel(text: string, lineNo: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inSingle || inDouble) {
    throw new ConfigError(`line ${lineNo}: unterminated string in array`);
  }
  parts.push(current);
  return parts;
}

function unescapeDouble(raw: string, lineNo: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else {
      throw new ConfigError(`line ${lineNo}: bad escape \\${next ?? ''}`);
    }
    i += 1;
  }
  return out;
}

function parseScalar(text: string, lineNo: number): unknown {
  const token = text.trim();
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return unescapeDouble(token.slice(1, -1), lineNo);
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1);
  }
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith('{')) {
    if (!token.endsWith('}')) {
      throw new ConfigError(`line ${lineNo}: unterminated inline table`);
    }
    return parseInlineTable(token.slice(1, -1), lineNo);
  }
  if (token.startsWith('[') && token.endsWith(']')) {
    const inner = token.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, lineNo).map((item) => {
      const value = parseScalar(item, lineNo);
      // Inline-table elements are the per-entry shape some array keys
      // validate themselves (`[roles.*].models`); nested
      // arrays stay unsupported, and every other array key still
      // refuses tables through its own typed checker.
      if (Array.isArray(value)) {
        throw new ConfigError(`line ${lineNo}: nested arrays are unsupported`);
      }
      return value;
    });
  }
  throw new ConfigError(`line ${lineNo}: cannot parse value ${token}`);
}

// A TOML inline table (`{ id = "acme/big", thinking = "high" }` in a role's
// `models` list): the parser supports exactly one level of it. Guarded like
// the section parser: dunder keys are refused and duplicates are named.
function parseInlineTable(
  inner: string,
  lineNo: number,
): Record<string, unknown> {
  const trimmed = inner.trim();
  const out: Record<string, unknown> = {};
  if (trimmed === '') return out;
  for (const entry of splitTopLevel(trimmed, lineNo)) {
    const [rawKey, rawValue] = splitEquals(entry.trim(), lineNo);
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new ConfigError(`line ${lineNo}: bad key '${key}'`);
    }
    assertSafePathKey(key, `line ${lineNo}`);
    if (Object.hasOwn(out, key)) {
      throw new ConfigError(`line ${lineNo}: duplicate key '${key}'`);
    }
    out[key] = parseScalar(rawValue, lineNo);
  }
  return out;
}

// Prototype-pollution guard: TOML section/key segments are
// attacker-controlled (project-local configs are post-trust files), so
// dunder segments must never be assigned onto plain objects —
// `obj['__proto__'] = ...` mutates Object.prototype instead of creating an
// own property. Rejected fail-closed at both assignment sites (setPath for
// parsing, unflatten for layer merging).
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafePathKey(key: string, context: string): void {
  if (UNSAFE_PATH_KEYS.has(key)) {
    throw new ConfigError(`${context}: forbidden key '${key}'`);
  }
}

function setPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
  lineNo: number,
): void {
  for (const key of path) assertSafePathKey(key, `line ${lineNo}`);
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string;
    const next = node[key];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else if (isRecord(next)) {
      node = next;
    } else {
      throw new ConfigError(
        `line ${lineNo}: '${path.slice(0, i + 1).join('.')}' is already a value`,
      );
    }
  }
  const leaf = path[path.length - 1] as string;
  if (Object.hasOwn(node, leaf)) {
    throw new ConfigError(`line ${lineNo}: duplicate key '${path.join('.')}'`);
  }
  node[leaf] = value;
}

// `[[audit]]`: append a fresh table to the array at `path` and
// return it so following key lines land inside that element. The path walk
// mirrors setPath's guards (dunder segments refused, collisions named) and
// the array container is created on first sight.
function appendArrayTable(
  root: Record<string, unknown>,
  path: string[],
  lineNo: number,
): Record<string, unknown> {
  for (const key of path) assertSafePathKey(key, `line ${lineNo}`);
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string;
    const next = node[key];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else if (isRecord(next)) {
      node = next;
    } else {
      throw new ConfigError(
        `line ${lineNo}: '${path.slice(0, i + 1).join('.')}' is already a value`,
      );
    }
  }
  const leaf = path[path.length - 1] as string;
  const existing = node[leaf];
  const fresh: Record<string, unknown> = {};
  if (existing === undefined) {
    node[leaf] = [fresh];
    return fresh;
  }
  if (!Array.isArray(existing)) {
    throw new ConfigError(
      `line ${lineNo}: '${path.join('.')}' is already a value`,
    );
  }
  existing.push(fresh);
  return fresh;
}

function parseTomlDocument(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: string[] = [];
  // The table key lines land in: `root` for ordinary sections, the newest
  // element for an `[[array-of-tables]]` header.
  let table: Record<string, unknown> = root;
  const lines = text.split('\n');
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = stripTrailingComment(rawLine).trim();
    if (line === '') return;
    const arrayHeader = /^\[\[([A-Za-z0-9_.-]+)\]\]$/.exec(line);
    if (arrayHeader !== null) {
      section = [];
      table = appendArrayTable(
        root,
        (arrayHeader[1] as string).split('.'),
        lineNo,
      );
      return;
    }
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      section = (header[1] as string).split('.');
      table = root;
      return;
    }
    if (line.startsWith('[')) {
      throw new ConfigError(`line ${lineNo}: bad section header`);
    }
    const [rawKey, rawValue] = splitEquals(line, lineNo);
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(key)) {
      throw new ConfigError(`line ${lineNo}: bad key '${key}'`);
    }
    setPath(
      table,
      [...section, ...key.split('.')],
      parseScalar(rawValue, lineNo),
      lineNo,
    );
  });
  return root;
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
  workspaceRoot?: string;
  enterprisePath?: string;
  productPath?: string;
}): Record<ConfigLayer, string | undefined> {
  return {
    enterprise: args.enterprisePath ?? join('/etc', 'kubic', 'config.toml'),
    product: args.productPath ?? join('/etc', 'kubic', 'product.toml'),
    global: join(args.home, '.kubic', 'config.toml'),
    project: join(args.projectRoot, '.kubic', 'config.toml'),
    workspace:
      args.workspaceRoot === undefined
        ? undefined
        : join(args.workspaceRoot, '.kubic', 'config.toml'),
    // Session + agent layers are supplied programmatically (never files).
    session: undefined,
    agent: undefined,
  };
}

// The rule set is owned by the module that writes it:
// @kubic/exec `runtime-exclude.ts` is what `kubic run` ships into a user
// repo, so this list is a projection of
// that module — never a second hand-maintained copy. `config.test.ts`
// pins the two together, so a rule added there cannot go unchecked here.
export const GITIGNORE_REQUIRED_ENTRIES = [...RUNTIME_EXCLUDE_ENTRIES] as const;

export function checkGitignoreSplit(gitignoreText: string): {
  missing: string[];
} {
  return {
    missing: GITIGNORE_REQUIRED_ENTRIES.filter(
      (entry) => !gitignoreText.includes(entry),
    ),
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

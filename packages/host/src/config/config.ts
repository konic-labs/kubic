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
// module never touches node:fs directly. Never imports worker impl.

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RUNTIME_EXCLUDE_ENTRIES } from '../../../exec/src/runtime-exclude.js';
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

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ProjectUntrustedError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectUntrustedError';
  }
}

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

export const VERIFY_COMMAND_KEYS = [
  'tests',
  'build',
  'lint',
  'typecheck',
] as const;

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

// `[[audit]]` (parsed here; built in policy/audit-ledger.ts).
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

const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const KNOWN_SECTIONS = new Set([
  'agent',
  'model',
  'approvals',
  'permissions',
  'journal',
  'roles',
  'ui',
  'session',
  'verify',
  'policy',
  'audit',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function reqString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  optional: true,
): string | undefined;
function reqString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  optional: false,
): string;
function reqString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  optional: boolean,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    if (optional) return undefined;
    throw new ConfigError(`'${path}': '${key}' must be a non-empty string`);
  }
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`'${path}': '${key}' must be a non-empty string`);
  }
  return value;
}

function optBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`'${path}': '${key}' must be a boolean`);
  }
  return value;
}

function optNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`'${path}': '${key}' must be a non-negative number`);
  }
  return value;
}

function optStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`'${path}': '${key}' must be a string array`);
  }
  return [...(value as string[])];
}

// Out-of-scope paths: a string array of plain relative
// paths. The shape check is the same one every other string-array key gets
// (`optStringArray`) and the extra rule is that an empty entry is refused by
// name: a workspace-relative path never starts with `/`, so an empty entry
// matches nothing and would be dead config that silently configures nothing.
// The runtime projection re-checks this rule because programmatic
// session/agent layers never pass through this parser.
export function checkOutOfScopeEntries(
  value: unknown,
  keyPath: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`'${keyPath}': 'outOfScope' must be a string array`);
  }
  const entries = [...(value as string[])];
  const empty = entries.findIndex((entry) => entry.trim() === '');
  if (empty >= 0) {
    throw new ConfigError(
      `'${keyPath}': 'outOfScope' entry ${empty + 1} is empty — declare a relative path, or drop the entry`,
    );
  }
  return entries;
}

// Journal byte bound: a positive integer or nothing. 0 is
// refused by name — it is not "retention off" (unset is), it is a bound
// nothing can fit, so every append would be refused and every tool write
// would fail as journal_failed. Refused here rather than clamped.
function checkJournalMaxBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError("'journal': 'maxBytes' must be a positive integer");
  }
  return value;
}

// Session compaction policy: shared by the TOML parser
// and the runtime projection, which re-checks because the programmatic
// session/agent layers never pass through the parser. A non-boolean switch
// and a non-positive-safe-integer token count are refused by key name —
// fail closed, never a half-applied policy.
export function checkSessionCompaction(
  session: Record<string, unknown>,
  keyPath: string,
): Pick<SessionConfig, 'autoCompact' | 'reserveTokens' | 'keepRecentTokens'> {
  const rawAuto = session.autoCompact;
  if (rawAuto !== undefined && typeof rawAuto !== 'boolean') {
    throw new ConfigError(`'${keyPath}': 'autoCompact' must be a boolean`);
  }
  const checkTokens = (
    key: 'reserveTokens' | 'keepRecentTokens',
  ): number | undefined => {
    const value = session[key];
    if (value === undefined) return undefined;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new ConfigError(
        `'${keyPath}': '${key}' must be a positive integer`,
      );
    }
    return value;
  };
  const autoCompact = rawAuto as boolean | undefined;
  const reserveTokens = checkTokens('reserveTokens');
  const keepRecentTokens = checkTokens('keepRecentTokens');
  return {
    ...(autoCompact === undefined ? {} : { autoCompact }),
    ...(reserveTokens === undefined ? {} : { reserveTokens }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
  };
}

// Request options: the four tuning keys `[model]` and
// `[roles.<name>]` share. `timeoutMs` bounds one provider request (a
// positive integer of milliseconds — 0 would refuse every request, so it is
// refused by name); `maxRetries`/`maxRetryDelayMs` are non-negative
// integers (0 disables retries / the delay cap — both real provider
// meanings, never "unset"); `cacheRetention` names Pi's retention
// vocabulary. Refused by name here so a malformed value never reaches the
// lane; the runtime projection re-checks for the programmatic layers.
const STREAM_CACHE_RETENTIONS = ['none', 'short', 'long'] as const;

export function checkModelStreamTuning(
  record: Record<string, unknown>,
  keyPath: string,
): Pick<
  ModelConfig,
  'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention'
> {
  const out: Pick<
    ModelConfig,
    'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention'
  > = {};
  const timeoutMs = record.timeoutMs;
  if (timeoutMs !== undefined) {
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new ConfigError(
        `'${keyPath}': 'timeoutMs' must be a positive integer of milliseconds`,
      );
    }
    out.timeoutMs = timeoutMs;
  }
  for (const key of ['maxRetries', 'maxRetryDelayMs'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ConfigError(
        `'${keyPath}': '${key}' must be a non-negative integer`,
      );
    }
    out[key] = value;
  }
  const cacheRetention = record.cacheRetention;
  if (cacheRetention !== undefined) {
    if (
      typeof cacheRetention !== 'string' ||
      !(STREAM_CACHE_RETENTIONS as readonly string[]).includes(cacheRetention)
    ) {
      throw new ConfigError(
        `'${keyPath}': 'cacheRetention' must be one of ${STREAM_CACHE_RETENTIONS.join(', ')}`,
      );
    }
    out.cacheRetention = cacheRetention;
  }
  return out;
}

// Per-role model pin: a `provider/id` ref, never a bare
// provider or a half ref — the run path turns exactly this shape into a
// selection. Refused by name here so a malformed pin never reaches the lane;
// the runtime projection re-checks for the programmatic layers.
export function checkRoleModelRef(
  value: unknown,
  roleName: string,
): string | undefined {
  if (value === undefined) return undefined;
  const keyPath = `roles.${roleName}`;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`'${keyPath}': 'model' must be 'provider/id'`);
  }
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new ConfigError(
      `'${keyPath}': 'model' must be 'provider/id' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// One scoped-model entry: the allowed-set member a
// `[roles.*].models` array holds. String entries normalize to this shape
// at parse, so every layer downstream matches one shape.
export interface RoleModelEntry {
  /** `provider/id` or `provider/*` — the `*` form matches the provider. */
  id: string;
  /** The thinking default when the lane selects this entry (optional). */
  thinking?: string;
}

// The escalation ladder: ordered concrete
// `provider/id` rungs — never wildcards (a rung names the exact model the
// lane switches to, so one-way validation stays decidable) and never
// empty strings. Refused by name per entry, like the scoped-model set.
function checkEscalationLadder(
  value: unknown,
  keyPath: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `'${keyPath}': 'escalate' must be an array of 'provider/id' rungs`,
    );
  }
  return value.map((entry, index) => {
    const label = `'${keyPath}': 'escalate[${index}]'`;
    if (typeof entry !== 'string') {
      throw new ConfigError(
        `${label} must be 'provider/id' (got ${JSON.stringify(entry)})`,
      );
    }
    const slash = entry.indexOf('/');
    if (slash <= 0 || slash === entry.length - 1 || entry.includes('*')) {
      throw new ConfigError(
        `${label} must be 'provider/id' (got ${JSON.stringify(entry)})`,
      );
    }
    return entry;
  });
}

function checkMaxEscalations(
  value: unknown,
  keyPath: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `'${keyPath}': 'maxEscalations' must be a non-negative integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// The per-role allowed set: an array of `provider/id`
// or `provider/*` refs, each optionally carrying per-entry thinking as a
// table (`{ id, thinking? }`). An empty array parses (it means all
// models). Refused by name per entry so a malformed set never reaches
// selection; the runtime projection re-checks for programmatic layers.
function checkRoleModels(
  value: unknown,
  roleName: string,
): RoleModelEntry[] | undefined {
  if (value === undefined) return undefined;
  const keyPath = `roles.${roleName}`;
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `'${keyPath}': 'models' must be an array of 'provider/id' or 'provider/*' entries`,
    );
  }
  return value.map((entry, index) => {
    const label = `'${keyPath}': 'models[${index}]'`;
    if (typeof entry === 'string') {
      return { id: checkRoleModelPattern(entry, label) };
    }
    if (!isRecord(entry)) {
      throw new ConfigError(
        `${label} must be 'provider/id' or 'provider/*' (got ${JSON.stringify(entry)})`,
      );
    }
    checkNoUnknown(
      entry,
      new Set(['id', 'thinking']),
      `${keyPath}.models[${index}]`,
    );
    const id = checkRoleModelPattern(
      reqString(entry, 'id', `${keyPath}.models[${index}]`, false),
      label,
    );
    const thinking = checkThinkingLevel(
      reqString(entry, 'thinking', `${keyPath}.models[${index}]`, true),
      `'${keyPath}': 'models[${index}].thinking'`,
    );
    return { id, ...(thinking === undefined ? {} : { thinking }) };
  });
}

// One allowed-set member: `provider/id` exact, or `provider/*` for the
// whole provider. The `*` is only meaningful as the whole id — anywhere
// else it is a typo refused by name.
function checkRoleModelPattern(value: string, label: string): string {
  const slash = value.indexOf('/');
  const star = value.indexOf('*');
  if (
    slash <= 0 ||
    slash === value.length - 1 ||
    (star >= 0 && (star !== value.length - 1 || !value.endsWith('/*')))
  ) {
    throw new ConfigError(
      `${label} must be 'provider/id' or 'provider/*' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}
// One thinking-level rule for every spelling of it: the
// `[model]` and `[roles.*]` keys, KUBIC_MODEL_THINKING and --thinking all
// refuse a value outside THINKING_LEVELS by the name the operator used.
export function checkThinkingLevel(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new ConfigError(
      `${label} must be one of ${THINKING_LEVELS.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// Shared by the TOML parser and the programmatic session/agent layers
// (runtime.ts), which never pass through the parser: a blank or non-string
// command and a non-positive or fractional timeout are refused by name.
export function checkVerifyConfig(
  verify: Record<string, unknown>,
  keyPath: string,
): VerifyConfig {
  checkNoUnknown(
    verify,
    new Set([...VERIFY_COMMAND_KEYS, 'timeoutMs']),
    keyPath,
  );
  const parsed: VerifyConfig = {};
  for (const key of VERIFY_COMMAND_KEYS) {
    const value = verify[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(
        `'${keyPath}': '${key}' must be a non-empty command string`,
      );
    }
    parsed[key] = value;
  }
  const timeoutMs = verify.timeoutMs;
  if (timeoutMs !== undefined) {
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new ConfigError(
        `'${keyPath}': 'timeoutMs' must be a positive integer of milliseconds`,
      );
    }
    parsed.timeoutMs = timeoutMs;
  }
  return parsed;
}

function checkNoUnknown(
  record: Record<string, unknown>,
  known: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new ConfigError(`'${path}': unknown key '${key}'`);
    }
  }
}

// Keys and their allowed values. The engine vocabulary
// names are accepted alongside the design's spellings so one section can
// carry either; the translation to LayerPolicy lives in host/policy.
const POLICY_KEYS = new Set([
  'allowed_models',
  'allowed_providers',
  'allowed_tools',
  'denied_tools',
  'network_policy',
  'allowed_domains',
  'filesystem_policy',
  'data_policy',
  'logging_policy',
]);

const NETWORK_POLICIES = ['proxy', 'none', 'allowlist', 'full'] as const;
const FILESYSTEM_POLICIES = [
  'workspace-only',
  'none',
  'read',
  'workspace-write',
  'full',
] as const;
const AUDIT_SINKS = ['syslog', 'file', 'memory'] as const;
const AUDIT_LEVELS = ['privileged', 'all'] as const;

function parsePolicySection(raw: unknown): PolicyConfig {
  if (!isRecord(raw)) {
    throw new ConfigError("'[policy]' must be a table");
  }
  checkNoUnknown(raw, POLICY_KEYS, 'policy');
  const allowedModels = optStringArray(raw, 'allowed_models', 'policy');
  const allowedProviders = optStringArray(raw, 'allowed_providers', 'policy');
  const allowedTools = optStringArray(raw, 'allowed_tools', 'policy');
  const deniedTools = optStringArray(raw, 'denied_tools', 'policy');
  const networkPolicy = reqString(raw, 'network_policy', 'policy', true);
  if (
    networkPolicy !== undefined &&
    !(NETWORK_POLICIES as readonly string[]).includes(networkPolicy)
  ) {
    throw new ConfigError(
      `'policy': 'network_policy' must be one of ${NETWORK_POLICIES.join(', ')}`,
    );
  }
  const allowedDomains = optStringArray(raw, 'allowed_domains', 'policy');
  const filesystemPolicy = reqString(raw, 'filesystem_policy', 'policy', true);
  if (
    filesystemPolicy !== undefined &&
    !(FILESYSTEM_POLICIES as readonly string[]).includes(filesystemPolicy)
  ) {
    throw new ConfigError(
      `'policy': 'filesystem_policy' must be one of ${FILESYSTEM_POLICIES.join(', ')}`,
    );
  }
  const dataPolicy = reqString(raw, 'data_policy', 'policy', true);
  const loggingPolicy = reqString(raw, 'logging_policy', 'policy', true);
  return {
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(allowedProviders === undefined ? {} : { allowedProviders }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(deniedTools === undefined ? {} : { deniedTools }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(filesystemPolicy === undefined ? {} : { filesystemPolicy }),
    ...(dataPolicy === undefined ? {} : { dataPolicy }),
    ...(loggingPolicy === undefined ? {} : { loggingPolicy }),
  };
}

// `[[audit]]`: each element names a sink kind and a level; a
// `target` (path or host:port) and `facility` are accepted for the sink
// follow-up. Unknown kinds, levels and keys are refused by name.
function parseAuditTables(raw: unknown): AuditTableConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      "'[[audit]]' must be an array of tables (use '[[audit]]', not '[audit]')",
    );
  }
  return raw.map((entry, index) => {
    const path = `audit[${index + 1}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(`'${path}' must be a table`);
    }
    checkNoUnknown(
      entry,
      new Set(['sink', 'level', 'target', 'facility']),
      path,
    );
    const sink = reqString(entry, 'sink', path, false);
    if (!(AUDIT_SINKS as readonly string[]).includes(sink)) {
      throw new ConfigError(
        `'${path}': 'sink' must be one of ${AUDIT_SINKS.join(', ')}`,
      );
    }
    const level = reqString(entry, 'level', path, false);
    if (!(AUDIT_LEVELS as readonly string[]).includes(level)) {
      throw new ConfigError(
        `'${path}': 'level' is required and must be one of ${AUDIT_LEVELS.join(', ')}`,
      );
    }
    const target = reqString(entry, 'target', path, true);
    // Docs promise a name or a number
    // 0–23, so a TOML number rides through as-is; a fractional or
    // out-of-range number is refused here, by name.
    const facilityRaw = entry.facility;
    if (
      facilityRaw !== undefined &&
      typeof facilityRaw === 'number' &&
      (!Number.isInteger(facilityRaw) || facilityRaw < 0 || facilityRaw > 23)
    ) {
      throw new ConfigError(
        `'${path}': 'facility' must be a facility name or a number 0–23`,
      );
    }
    const facility =
      typeof facilityRaw === 'number'
        ? facilityRaw
        : reqString(entry, 'facility', path, true);
    return {
      sink,
      level,
      ...(target === undefined ? {} : { target }),
      ...(facility === undefined ? {} : { facility }),
    };
  });
}

function toKubicConfig(raw: Record<string, unknown>): KubicConfig {
  assertNoMcpConfig(raw);
  for (const key of Object.keys(raw)) {
    // `skills` is a top-level array key, not a section.
    if (key !== 'skills' && !KNOWN_SECTIONS.has(key)) {
      throw new ConfigError(`unknown section '[${key}]'`);
    }
  }
  const config: KubicConfig = {};
  const agent = raw.agent;
  if (agent !== undefined) {
    if (!isRecord(agent)) throw new ConfigError("'[agent]' must be a table");
    checkNoUnknown(agent, new Set(['name', 'systemPromptFile']), 'agent');
    const name = reqString(agent, 'name', 'agent', true);
    const systemPromptFile = reqString(
      agent,
      'systemPromptFile',
      'agent',
      true,
    );
    if (name !== undefined || systemPromptFile !== undefined) {
      config.agent = {
        ...(name === undefined ? {} : { name }),
        ...(systemPromptFile === undefined ? {} : { systemPromptFile }),
      };
    }
  }
  const model = raw.model;
  if (model !== undefined) {
    if (!isRecord(model)) throw new ConfigError("'[model]' must be a table");
    checkNoUnknown(
      model,
      new Set([
        'provider',
        'id',
        'thinking',
        'timeoutMs',
        'maxRetries',
        'maxRetryDelayMs',
        'cacheRetention',
        'escalate',
        'maxEscalations',
      ]),
      'model',
    );
    const provider = reqString(model, 'provider', 'model', true);
    const id = reqString(model, 'id', 'model', true);
    const thinking = checkThinkingLevel(
      reqString(model, 'thinking', 'model', true),
      "'model': 'thinking'",
    );
    const escalate = checkEscalationLadder(model.escalate, 'model');
    const maxEscalations = checkMaxEscalations(model.maxEscalations, 'model');
    config.model = {
      ...(provider === undefined ? {} : { provider }),
      ...(id === undefined ? {} : { id }),
      ...(thinking === undefined ? {} : { thinking }),
      ...checkModelStreamTuning(model, 'model'),
      ...(escalate === undefined ? {} : { escalate }),
      ...(maxEscalations === undefined ? {} : { maxEscalations }),
    };
  }
  const approvals = raw.approvals;
  if (approvals !== undefined) {
    if (!isRecord(approvals)) {
      throw new ConfigError("'[approvals]' must be a table");
    }
    checkNoUnknown(
      approvals,
      new Set([
        'route',
        'maxPendingMs',
        'autoApprove',
        'sessionScoped',
        'requireJustification',
      ]),
      'approvals',
    );
    const route = approvals.route ?? 'ask-user';
    if (route !== 'ask-user' && route !== 'deny') {
      throw new ConfigError(
        `'approvals': 'route' must be 'ask-user' or 'deny'`,
      );
    }
    const maxPendingMs = optNumber(approvals, 'maxPendingMs', 'approvals');
    const autoApprove = optStringArray(approvals, 'autoApprove', 'approvals');
    const sessionScoped = optBoolean(approvals, 'sessionScoped', 'approvals');
    const requireJustification = optBoolean(
      approvals,
      'requireJustification',
      'approvals',
    );
    config.approvals = {
      route,
      ...(maxPendingMs === undefined ? {} : { maxPendingMs }),
      ...(autoApprove === undefined ? {} : { autoApprove }),
      ...(sessionScoped === undefined ? {} : { sessionScoped }),
      ...(requireJustification === undefined ? {} : { requireJustification }),
    };
  }
  const permissions = raw.permissions;
  if (permissions !== undefined) {
    if (!isRecord(permissions)) {
      throw new ConfigError("'[permissions]' must be a table");
    }
    checkNoUnknown(
      permissions,
      new Set(['filesystem', 'shell', 'network', 'git', 'credentials']),
      'permissions',
    );
    const parsed: PermissionsConfig = {};
    for (const key of [
      'filesystem',
      'shell',
      'network',
      'git',
      'credentials',
    ] as const) {
      const value = permissions[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new ConfigError(
          `'permissions': '${key}' must be a string level or a boolean`,
        );
      }
      parsed[key] = value;
    }
    config.permissions = parsed;
  }
  const journal = raw.journal;
  if (journal !== undefined) {
    if (!isRecord(journal)) {
      throw new ConfigError("'[journal]' must be a table");
    }
    checkNoUnknown(
      journal,
      new Set(['retentionDays', 'maxBytes', 'outOfScope']),
      'journal',
    );
    const retentionDays = optNumber(journal, 'retentionDays', 'journal');
    const maxBytes = checkJournalMaxBytes(journal.maxBytes);
    const outOfScope = checkOutOfScopeEntries(journal.outOfScope, 'journal');
    config.journal = {
      ...(retentionDays === undefined ? {} : { retentionDays }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(outOfScope === undefined ? {} : { outOfScope }),
    };
  }
  const roles = raw.roles;
  if (roles !== undefined) {
    if (!isRecord(roles)) throw new ConfigError("'[roles]' must be a table");
    const parsed: Record<string, RoleConfig> = {};
    for (const [name, spec] of Object.entries(roles)) {
      if (!isRecord(spec)) {
        throw new ConfigError(`'[roles.${name}]' must be a table`);
      }
      checkNoUnknown(
        spec,
        new Set([
          'model',
          'tools',
          'requires',
          'thinking',
          'models',
          'timeoutMs',
          'maxRetries',
          'maxRetryDelayMs',
          'cacheRetention',
          'escalate',
        ]),
        `roles.${name}`,
      );
      const modelRef = checkRoleModelRef(spec.model, name);
      const tools = optStringArray(spec, 'tools', `roles.${name}`);
      const requires = optStringArray(spec, 'requires', `roles.${name}`);
      const thinking = checkThinkingLevel(
        reqString(spec, 'thinking', `roles.${name}`, true),
        `'roles.${name}': 'thinking'`,
      );
      const models = checkRoleModels(spec.models, name);
      const escalate = checkEscalationLadder(spec.escalate, `roles.${name}`);
      parsed[name] = {
        ...(modelRef === undefined ? {} : { model: modelRef }),
        ...(tools === undefined ? {} : { tools }),
        ...(requires === undefined ? {} : { requires }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(models === undefined ? {} : { models }),
        ...(escalate === undefined ? {} : { escalate }),
        ...checkModelStreamTuning(spec, `roles.${name}`),
      };
    }
    config.roles = parsed;
  }
  const ui = raw.ui;
  if (ui !== undefined) {
    if (!isRecord(ui)) throw new ConfigError("'[ui]' must be a table");
    checkNoUnknown(ui, new Set(['theme', 'statusBar']), 'ui');
    const theme = reqString(ui, 'theme', 'ui', true);
    const statusBar = optBoolean(ui, 'statusBar', 'ui');
    config.ui = {
      ...(theme === undefined ? {} : { theme }),
      ...(statusBar === undefined ? {} : { statusBar }),
    };
  }
  const session = raw.session;
  if (session !== undefined) {
    if (!isRecord(session)) {
      throw new ConfigError("'[session]' must be a table");
    }
    checkNoUnknown(
      session,
      new Set([
        'store',
        'dir',
        'retentionDays',
        'autoCompact',
        'reserveTokens',
        'keepRecentTokens',
      ]),
      'session',
    );
    const store = reqString(session, 'store', 'session', true);
    const dir = reqString(session, 'dir', 'session', true);
    const retentionDays = optNumber(session, 'retentionDays', 'session');
    const compaction = checkSessionCompaction(session, 'session');
    config.session = {
      ...(store === undefined ? {} : { store }),
      ...(dir === undefined ? {} : { dir }),
      ...(retentionDays === undefined ? {} : { retentionDays }),
      ...compaction,
    };
  }
  const verify = raw.verify;
  if (verify !== undefined) {
    if (!isRecord(verify)) {
      throw new ConfigError("'[verify]' must be a table");
    }
    config.verify = checkVerifyConfig(verify, 'verify');
  }
  const policy = raw.policy;
  if (policy !== undefined) {
    config.policy = parsePolicySection(policy);
  }
  const audit = raw.audit;
  if (audit !== undefined) {
    config.audit = parseAuditTables(audit);
  }
  // `skills = [...]` — files or directories. Kept
  // as written here; the load resolves relative entries against the
  // declaring file's directory. A non-string entry names the layer.
  const skills = raw.skills;
  if (skills !== undefined) {
    if (!Array.isArray(skills)) {
      throw new ConfigError("'skills' must be an array of paths");
    }
    for (const entry of skills) {
      if (typeof entry !== 'string') {
        throw new ConfigError("'skills' entries must be strings");
      }
      if (entry.trim() === '') {
        throw new ConfigError("'skills' entries must not be blank");
      }
    }
    config.skills = [...skills];
  }
  return config;
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

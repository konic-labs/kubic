// The value checks the schema names (schema.ts). Each refuses a value by the
// key's name, so a malformed value never reaches the lane, and returns the
// value the parse keeps. The runtime re-runs the same checks for the
// programmatic session/agent layers, which never pass through the TOML
// parser.
import { posix } from 'node:path';
import { ConfigError } from './errors.js';
import type { ConfigKey, KeyCheck } from './schema.js';

const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

// The longest delay a timer can hold. Node clamps a longer one (an
// infinite one included) to 1 ms, so a configured bound past it would fire
// at once instead of waiting: every key that feeds a timer is refused past
// it, by name.
const MAX_TIMER_MS = 2_147_483_647;

const CACHE_RETENTIONS = ['none', 'short', 'long'] as const;
const NETWORK_POLICIES = ['proxy', 'none', 'allowlist', 'full'] as const;
const PROJECT_POLICIES = ['open', 'restricted'] as const;
const HOOK_EVENTS = ['beforeTool', 'afterTool', 'runEnd'] as const;
const FILESYSTEM_POLICIES = [
  'workspace-only',
  'none',
  'read',
  'workspace-write',
  'full',
] as const;
const AUDIT_SINKS = ['syslog', 'file', 'memory', 'https', 'otlp'] as const;
const AUDIT_LEVELS = ['privileged', 'all'] as const;

// One scoped-model entry: the allowed-set member a
// `[roles.*].models` array holds. String entries normalize to this shape
// at parse, so every layer downstream matches one shape.
export interface RoleModelEntry {
  /** `provider/id` or `provider/*` — the `*` form matches the provider. */
  id: string;
  /** The thinking default when the lane selects this entry (optional). */
  thinking?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkNoUnknown(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new ConfigError(`'${path}': unknown key '${key}'`);
    }
  }
}

// The declared keys of one table, checked in declaration order; the parsed
// table holds the keys that were set (and the defaults a key fills in).
export function checkKeys(
  keys: readonly ConfigKey[],
  record: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    let value = record[key.name];
    if (value === undefined) {
      if (key.required === true) {
        throw new ConfigError(
          `'${path}': '${key.name}' must be a non-empty string`,
        );
      }
      if (key.fill !== true || key.default === undefined) continue;
      value = key.default;
    }
    out[key.field ?? key.name] = CHECKS[key.check](value, path, key.name);
  }
  return out;
}

type Check = (value: unknown, path: string, key: string) => unknown;

const CHECKS: Record<KeyCheck, Check> = {
  string: nonEmptyString,
  boolean: (value, path, key) => {
    if (typeof value !== 'boolean') {
      throw new ConfigError(`'${path}': '${key}' must be a boolean`);
    }
    return value;
  },
  number: nonNegativeNumber,
  strings: (value, path, key) => {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      throw new ConfigError(`'${path}': '${key}' must be a string array`);
    }
    return [...(value as string[])];
  },
  thinking: (value, path, key) =>
    checkThinkingLevel(nonEmptyString(value, path, key), `'${path}': '${key}'`),
  permission: (value, path, key) => {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new ConfigError(
        `'${path}': '${key}' must be a string level or a boolean`,
      );
    }
    return value;
  },
  timeoutMs: (value, path, key) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ConfigError(
        `'${path}': '${key}' must be a positive integer of milliseconds`,
      );
    }
    return timerMs(value, path, key);
  },
  count: nonNegativeInteger,
  retryDelayMs: (value, path, key) =>
    timerMs(nonNegativeInteger(value, path, key), path, key),
  cacheRetention: (value, path, key) => {
    if (
      typeof value !== 'string' ||
      !(CACHE_RETENTIONS as readonly string[]).includes(value)
    ) {
      throw new ConfigError(
        `'${path}': '${key}' must be one of ${CACHE_RETENTIONS.join(', ')}`,
      );
    }
    return value;
  },
  approvalRoute: (value, path, key) => {
    if (value !== 'ask-user' && value !== 'deny') {
      throw new ConfigError(`'${path}': '${key}' must be 'ask-user' or 'deny'`);
    }
    return value;
  },
  pendingMs: (value, path, key) =>
    timerMs(nonNegativeNumber(value, path, key), path, key),
  // 0 is refused by name — it is not "retention off" (unset is), it is a
  // bound nothing can fit, so every append would be refused and every tool
  // write would fail as journal_failed.
  journalBytes: (value, path, key) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new ConfigError(`'${path}': '${key}' must be a positive integer`);
    }
    return value;
  },
  outOfScope: (value, path) => checkOutOfScopeEntries(value, path),
  escalate: (value, path) => checkEscalationLadder(value, path),
  maxEscalations: (value, path, key) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ConfigError(
        `'${path}': '${key}' must be a non-negative integer (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  },
  roleModel: (value, path) => checkModelRef(value, path),
  roleModels: (value, path) => checkRoleModels(value, path),
  tokens: (value, path, key) => {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new ConfigError(`'${path}': '${key}' must be a positive integer`);
    }
    return value;
  },
  command: (value, path, key) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(
        `'${path}': '${key}' must be a non-empty command string`,
      );
    }
    return value;
  },
  networkPolicy: (value, path, key) =>
    oneOf(nonEmptyString(value, path, key), NETWORK_POLICIES, path, key),
  filesystemPolicy: (value, path, key) =>
    oneOf(nonEmptyString(value, path, key), FILESYSTEM_POLICIES, path, key),
  projectPolicy: (value, path, key) =>
    oneOf(nonEmptyString(value, path, key), PROJECT_POLICIES, path, key),
  hookEvent: (value, path, key) =>
    oneOf(nonEmptyString(value, path, key), HOOK_EVENTS, path, key),
  auditSink: (value, path, key) =>
    oneOf(nonEmptyString(value, path, key), AUDIT_SINKS, path, key),
  auditLevel: (value, path, key) => {
    const level = nonEmptyString(value, path, key);
    if (!(AUDIT_LEVELS as readonly string[]).includes(level)) {
      throw new ConfigError(
        `'${path}': '${key}' is required and must be one of ${AUDIT_LEVELS.join(', ')}`,
      );
    }
    return level;
  },
  // A name or a number 0–23, so a TOML number rides through as-is; a
  // fractional or out-of-range number is refused by name.
  facility: (value, path, key) => {
    if (typeof value !== 'number') return nonEmptyString(value, path, key);
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new ConfigError(
        `'${path}': '${key}' must be a facility name or a number 0–23`,
      );
    }
    return value;
  },
  // Files or directories, kept as written; the load resolves relative
  // entries against the declaring file's directory. A non-string or blank
  // entry names the key.
  skills: (value) => {
    if (!Array.isArray(value)) {
      throw new ConfigError("'skills' must be an array of paths");
    }
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new ConfigError("'skills' entries must be strings");
      }
      if (entry.trim() === '') {
        throw new ConfigError("'skills' entries must not be blank");
      }
    }
    return [...(value as string[])];
  },
};

function nonEmptyString(value: unknown, path: string, key: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`'${path}': '${key}' must be a non-empty string`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`'${path}': '${key}' must be a non-negative number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`'${path}': '${key}' must be a non-negative integer`);
  }
  return value;
}

function timerMs(value: number, path: string, key: string): number {
  if (value > MAX_TIMER_MS) {
    throw new ConfigError(
      `'${path}': '${key}' must be at most ${MAX_TIMER_MS} milliseconds (about 24.8 days)`,
    );
  }
  return value;
}

function oneOf(
  value: string,
  allowed: readonly string[],
  path: string,
  key: string,
): string {
  if (!allowed.includes(value)) {
    throw new ConfigError(
      `'${path}': '${key}' must be one of ${allowed.join(', ')}`,
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

// Out-of-scope paths: a string array of plain relative
// paths, and an empty entry is refused by name: a workspace-relative path
// never starts with `/`, so an empty entry matches nothing and would be dead
// config that silently configures nothing.
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
  // The walk compares workspace-relative paths literally, so each entry is
  // read as the plain path it names: `./dist` and `dist/` are `dist`. One
  // that names the whole workspace would leave the journal recording
  // nothing, and one outside the workspace names nothing the journal walks.
  return entries.map((entry, index) => {
    const at = `'${keyPath}': 'outOfScope' entry ${index + 1}`;
    if (entry.startsWith('/')) {
      throw new ConfigError(
        `${at} is outside the workspace (${JSON.stringify(entry)}) — declare a path relative to the workspace`,
      );
    }
    const plain = posix.normalize(entry).replace(/\/+$/, '');
    if (plain === '.' || plain === '') {
      throw new ConfigError(
        `${at} names the whole workspace (${JSON.stringify(entry)}) — the journal would record nothing; list the paths to leave out instead`,
      );
    }
    if (plain === '..' || plain.startsWith('../')) {
      throw new ConfigError(
        `${at} is outside the workspace (${JSON.stringify(entry)}) — declare a path relative to the workspace`,
      );
    }
    return plain;
  });
}

// Per-role model pin: a `provider/id` ref, never a bare
// provider or a half ref — the run path turns exactly this shape into a
// selection.
export function checkRoleModelRef(
  value: unknown,
  roleName: string,
): string | undefined {
  if (value === undefined) return undefined;
  return checkModelRef(value, `roles.${roleName}`);
}

function checkModelRef(value: unknown, keyPath: string): string {
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

// The escalation ladder: ordered concrete
// `provider/id` rungs — never wildcards (a rung names the exact model the
// lane switches to, so one-way validation stays decidable) and never
// empty strings. Refused by name per entry, like the scoped-model set.
function checkEscalationLadder(value: unknown, keyPath: string): string[] {
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

// The per-role allowed set: an array of `provider/id`
// or `provider/*` refs, each optionally carrying per-entry thinking as a
// table (`{ id, thinking? }`). An empty array parses (it means all
// models). Refused by name per entry so a malformed set never reaches
// selection.
function checkRoleModels(value: unknown, keyPath: string): RoleModelEntry[] {
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
    const entryPath = `${keyPath}.models[${index}]`;
    checkNoUnknown(entry, new Set(['id', 'thinking']), entryPath);
    if (entry.id === undefined) {
      throw new ConfigError(`'${entryPath}': 'id' must be a non-empty string`);
    }
    const id = checkRoleModelPattern(
      nonEmptyString(entry.id, entryPath, 'id'),
      label,
    );
    const thinking = checkThinkingLevel(
      entry.thinking === undefined
        ? undefined
        : nonEmptyString(entry.thinking, entryPath, 'thinking'),
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

// Layered TOML config with enterprise supremacy (issue #38; design §35).
// Roots: ~/.kubic/ (global) + .kubic/ (project-local, trust-gated).
// Precedence: Enterprise > Global > Project > Workspace > Session > Agent —
// a lower layer can never override a key set by a higher layer (enterprise
// keys are frozen against every override attempt).
// Canonical shape: agent/model/thinking, mode flags, approvals
// (ask-user + deny-on-timeout), journal retention, per-role model/tools,
// orchestrator root, ui, session store + retention. No budgets: budget
// keys are rejected, never defaulted. Secrets never appear here (see
// secrets.ts).
//
// File access arrives as a FileBridge (exec-owned I/O confinement) — this
// module never touches node:fs directly. Never imports worker impl.

import { join } from 'node:path';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { RUNTIME_EXCLUDE_ENTRIES } from '../../../exec/src/runtime-exclude.js';
import { assertNoMcpConfig, McpUnsupportedError } from './stances.js';

export const CONFIG_LAYERS = [
  'enterprise',
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

export class BudgetKeyError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetKeyError';
  }
}

export interface AgentConfig {
  name?: string;
}

export interface ModelConfig {
  provider?: string;
  id?: string;
  thinking?: string;
}

export interface ModesConfig {
  solo?: boolean;
  orchestrator?: boolean;
}

export interface ApprovalsConfig {
  route?: 'ask-user' | 'deny';
  maxPendingMs?: number;
  autoApprove?: string[];
  sessionScoped?: boolean;
  requireJustification?: boolean;
}

// Permission classes (§40) as a config section (issue #90): the values are
// validated against the agents-owned level vocabulary (validateClasses) when
// the runtime projection consumes them — never re-listed here.
export interface PermissionsConfig {
  filesystem?: string | boolean;
  shell?: string | boolean;
  network?: string | boolean;
  git?: string | boolean;
  credentials?: string | boolean;
}

export interface JournalConfig {
  retentionDays?: number;
  /**
   * §35 out-of-scope paths (issue #115): workspace-relative paths excluded
   * from the §42.5 baseline and the end-of-run sweep. An entry excludes the
   * path itself and everything under it — `dist` ⇒ `dist`, `dist/a.js`,
   * `dist/sub/b.js`. Plain paths only (patterns belong in `.gitignore`);
   * `.git/` and `.kubic/` stay hard-skipped before any config.
   */
  outOfScope?: string[];
}

export interface RoleConfig {
  model?: string;
  tools?: string[];
}

export interface OrchestratorConfig {
  root?: string;
  maxWorkers?: number;
}

export interface UiConfig {
  theme?: string;
  statusBar?: boolean;
}

export interface SessionConfig {
  store?: string;
  dir?: string;
  // Retention for session state (issue #119): the default keep-window for
  // `kubic sessions prune`, in days. Unset means "off" — prune then
  // demands an explicit --keep-days rather than inventing a window; 0 also
  // means off (retention disabled, never "everything is old").
  retentionDays?: number;
}

export interface KubicConfig {
  agent?: AgentConfig;
  model?: ModelConfig;
  modes?: ModesConfig;
  approvals?: ApprovalsConfig;
  permissions?: PermissionsConfig;
  journal?: JournalConfig;
  roles?: Record<string, RoleConfig>;
  orchestrator?: OrchestratorConfig;
  ui?: UiConfig;
  session?: SessionConfig;
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
  'modes',
  'approvals',
  'permissions',
  'journal',
  'roles',
  'orchestrator',
  'ui',
  'session',
]);

// Exported for the docs-drift gate (issue #90): the page's Shape paragraph
// and example.toml must name exactly these sections.
export const KNOWN_CONFIG_SECTIONS: readonly string[] = [...KNOWN_SECTIONS];

// Canonical example (§35.2/§63) — kept in sync with example.toml (pinned by
// test). Committed shape only: sessions/journal/artifacts/worktrees are
// runtime state, never config.
export const EXAMPLE_TOML = `# Kubic canonical config example (issue #38; design §35.2/§63).
# Committed to the repo: .kubic/config.toml + .kubic/roles/*.md
# Never committed: sessions/ journal/ artifacts/ wt/ orchestrator/

[agent]
name = "kubic"

[model]
provider = "local"
id = "llama3"
thinking = "medium"

[modes]
solo = true
orchestrator = false

[approvals]
route = "ask-user"
maxPendingMs = 30000
autoApprove = []
sessionScoped = true
requireJustification = false

[permissions]
filesystem = "workspace-write"
shell = true
network = "none"
git = "workspace"
credentials = "none"

[journal]
retentionDays = 30

[roles.reviewer]
model = "local/llama3"
tools = ["read", "grep", "diff"]

[roles.implementer]
model = "local/llama3"
tools = ["read", "write", "edit", "bash"]

[orchestrator]
root = ".kubic/wt"
maxWorkers = 4

[ui]
theme = "dark"
statusBar = true

[session]
store = "jsonl"
dir = ".kubic/sessions"
retentionDays = 30
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNoBudgetKeys(raw: unknown): void {
  if (isRecord(raw) && Object.hasOwn(raw, 'budgets')) {
    throw new BudgetKeyError(
      'config key [budgets] is forbidden: budgets are never defaulted by config (issue #38)',
    );
  }
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
    } else if (ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ']') {
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
  if (token.startsWith('[') && token.endsWith(']')) {
    const inner = token.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, lineNo).map((item) => {
      const value = parseScalar(item, lineNo);
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new ConfigError(`line ${lineNo}: nested arrays are unsupported`);
      }
      return value;
    });
  }
  throw new ConfigError(`line ${lineNo}: cannot parse value ${token}`);
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

function parseTomlDocument(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: string[] = [];
  const lines = text.split('\n');
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = stripTrailingComment(rawLine).trim();
    if (line === '') return;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      section = (header[1] as string).split('.');
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
      root,
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

// §35 out-of-scope paths (issue #115): a string array of plain relative
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

function toKubicConfig(raw: Record<string, unknown>): KubicConfig {
  assertNoMcpConfig(raw);
  assertNoBudgetKeys(raw);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SECTIONS.has(key)) {
      throw new ConfigError(`unknown section '[${key}]'`);
    }
  }
  const config: KubicConfig = {};
  const agent = raw.agent;
  if (agent !== undefined) {
    if (!isRecord(agent)) throw new ConfigError("'[agent]' must be a table");
    checkNoUnknown(agent, new Set(['name']), 'agent');
    const name = reqString(agent, 'name', 'agent', true);
    if (name !== undefined) config.agent = { name };
  }
  const model = raw.model;
  if (model !== undefined) {
    if (!isRecord(model)) throw new ConfigError("'[model]' must be a table");
    checkNoUnknown(model, new Set(['provider', 'id', 'thinking']), 'model');
    const provider = reqString(model, 'provider', 'model', true);
    const id = reqString(model, 'id', 'model', true);
    const thinking = reqString(model, 'thinking', 'model', true);
    if (
      thinking !== undefined &&
      !(THINKING_LEVELS as readonly string[]).includes(thinking)
    ) {
      throw new ConfigError(
        `'model': 'thinking' must be one of ${THINKING_LEVELS.join(', ')}`,
      );
    }
    config.model = {
      ...(provider === undefined ? {} : { provider }),
      ...(id === undefined ? {} : { id }),
      ...(thinking === undefined ? {} : { thinking }),
    };
  }
  const modes = raw.modes;
  if (modes !== undefined) {
    if (!isRecord(modes)) throw new ConfigError("'[modes]' must be a table");
    checkNoUnknown(modes, new Set(['solo', 'orchestrator']), 'modes');
    const solo = optBoolean(modes, 'solo', 'modes');
    const orchestrator = optBoolean(modes, 'orchestrator', 'modes');
    config.modes = {
      ...(solo === undefined ? {} : { solo }),
      ...(orchestrator === undefined ? {} : { orchestrator }),
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
      new Set(['retentionDays', 'outOfScope']),
      'journal',
    );
    const retentionDays = optNumber(journal, 'retentionDays', 'journal');
    const outOfScope = checkOutOfScopeEntries(journal.outOfScope, 'journal');
    config.journal = {
      ...(retentionDays === undefined ? {} : { retentionDays }),
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
      checkNoUnknown(spec, new Set(['model', 'tools']), `roles.${name}`);
      const modelRef = reqString(spec, 'model', `roles.${name}`, true);
      const tools = optStringArray(spec, 'tools', `roles.${name}`);
      parsed[name] = {
        ...(modelRef === undefined ? {} : { model: modelRef }),
        ...(tools === undefined ? {} : { tools }),
      };
    }
    config.roles = parsed;
  }
  const orchestrator = raw.orchestrator;
  if (orchestrator !== undefined) {
    if (!isRecord(orchestrator)) {
      throw new ConfigError("'[orchestrator]' must be a table");
    }
    checkNoUnknown(
      orchestrator,
      new Set(['root', 'maxWorkers']),
      'orchestrator',
    );
    const root = reqString(orchestrator, 'root', 'orchestrator', true);
    const maxWorkers = optNumber(orchestrator, 'maxWorkers', 'orchestrator');
    config.orchestrator = {
      ...(root === undefined ? {} : { root }),
      ...(maxWorkers === undefined ? {} : { maxWorkers }),
    };
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
      new Set(['store', 'dir', 'retentionDays']),
      'session',
    );
    const store = reqString(session, 'store', 'session', true);
    const dir = reqString(session, 'dir', 'session', true);
    const retentionDays = optNumber(session, 'retentionDays', 'session');
    config.session = {
      ...(store === undefined ? {} : { store }),
      ...(dir === undefined ? {} : { dir }),
      ...(retentionDays === undefined ? {} : { retentionDays }),
    };
  }
  return config;
}

export function parseTomlConfig(text: string): KubicConfig {
  return toKubicConfig(parseTomlDocument(text));
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(', ')}]`;
  }
  throw new ConfigError('cannot serialize nested tables as values');
}

function emitTable(
  lines: string[],
  header: string,
  record: Record<string, unknown>,
): void {
  lines.push(`[${header}]`);
  for (const key of Object.keys(record).sort()) {
    lines.push(`${key} = ${formatValue(record[key])}`);
  }
  lines.push('');
}

export function serializeTomlConfig(config: KubicConfig): string {
  const lines: string[] = [];
  if (config.agent !== undefined) {
    emitTable(lines, 'agent', config.agent as Record<string, unknown>);
  }
  if (config.model !== undefined) {
    emitTable(lines, 'model', config.model as Record<string, unknown>);
  }
  if (config.modes !== undefined) {
    emitTable(lines, 'modes', config.modes as Record<string, unknown>);
  }
  if (config.approvals !== undefined) {
    emitTable(lines, 'approvals', config.approvals as Record<string, unknown>);
  }
  if (config.permissions !== undefined) {
    emitTable(
      lines,
      'permissions',
      config.permissions as Record<string, unknown>,
    );
  }
  if (config.journal !== undefined) {
    emitTable(lines, 'journal', config.journal as Record<string, unknown>);
  }
  if (config.roles !== undefined) {
    for (const name of Object.keys(config.roles).sort()) {
      emitTable(
        lines,
        `roles.${name}`,
        (config.roles[name] ?? {}) as Record<string, unknown>,
      );
    }
  }
  if (config.orchestrator !== undefined) {
    emitTable(
      lines,
      'orchestrator',
      config.orchestrator as Record<string, unknown>,
    );
  }
  if (config.ui !== undefined) {
    emitTable(lines, 'ui', config.ui as Record<string, unknown>);
  }
  if (config.session !== undefined) {
    emitTable(lines, 'session', config.session as Record<string, unknown>);
  }
  return lines.join('\n');
}

export interface LayerInput {
  layer: ConfigLayer;
  config: KubicConfig;
  // Project-local config is trust-gated: callers must pass trusted: true
  // only after the workspace trust prompt was accepted.
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
        'project-local config refused: accept the workspace trust prompt first (issue #38)',
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
}): Record<ConfigLayer, string | undefined> {
  return {
    enterprise: args.enterprisePath ?? join('/etc', 'kubic', 'config.toml'),
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

// Committed vs gitignored split: config.toml + roles/*.md are committed;
// sessions/journal/artifacts/worktrees/orchestrator state are runtime —
// gitignored and never committed.
export const COMMITTED_CONFIG_FILES = ['config.toml', 'roles/'] as const;

// The rule set is owned by the module that writes it (issue #91):
// @kubic/exec `runtime-exclude.ts` is what `kubic run` / `kubic
// orchestrate` ship into a user repo, so this list is a projection of
// that module — never a second hand-maintained copy. `config.test.ts`
// pins the two together, so a rule added there cannot go unchecked here.
export const GITIGNORE_REQUIRED_ENTRIES = [...RUNTIME_EXCLUDE_ENTRIES] as const;

export function isCommittedConfigPath(path: string): boolean {
  const normalized = path.startsWith('.kubic/')
    ? path.slice('.kubic/'.length)
    : path;
  return normalized === 'config.toml' || normalized.startsWith('roles/');
}

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
  if (error instanceof BudgetKeyError) {
    throw new BudgetKeyError(`layer '${layer}': ${error.message}`);
  }
  if (error instanceof ConfigError) {
    throw new ConfigError(`layer '${layer}': ${error.message}`);
  }
  throw new ConfigError(
    `layer '${layer}': ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Parse one layer's text with the layer named on every failure (issue #90):
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

// Layered load through the exec FileBridge. Project-local files are refused
// pre-trust (before reading); absent files are empty layers.
export function loadLayered(
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>,
  paths: Record<ConfigLayer, string | undefined>,
  opts: { projectTrusted?: boolean } = {},
): MergeResult {
  const inputs: LayerInput[] = [];
  for (const layer of CONFIG_LAYERS) {
    const path = paths[layer];
    if (path === undefined) continue;
    if (layer === 'project' && opts.projectTrusted !== true) {
      if (bridge.exists(path)) {
        throw new ProjectUntrustedError(
          `project-local config refused pre-trust: ${path} (issue #38)`,
        );
      }
      continue;
    }
    if (!bridge.exists(path)) continue;
    try {
      inputs.push({
        layer,
        config: parseTomlConfig(bridge.readTextFile(path)),
        ...(layer === 'project' ? { trusted: true as const } : {}),
      });
    } catch (error) {
      withLayerContext(layer, error);
    }
  }
  return mergeLayered(inputs);
}

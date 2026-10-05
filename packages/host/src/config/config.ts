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

import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  hasGitignoreMetacharacters,
  hasUnsafeCharacters,
  RUNTIME_EXCLUDE_ENTRIES,
} from '../../../exec/src/runtime-exclude.js';
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
   * The journal's byte bound (issue #350): the WHOLE store — `index.jsonl`
   * plus the blobs it references — is pruned on every append to stay under
   * this. Content addressing dedupes blobs, so without the index in the
   * bound a file toggling between two contents grew the journal without
   * limit. Unset ⇒ `DEFAULT_JOURNAL_MAX_BYTES` (100 MiB).
   */
  maxBytes?: number;
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
  // Issue #196 (§41.1): tool names that always require approval under
  // this role — forwarded to the resolver layers like `tools`.
  requires?: string[];
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

// §48 gate commands (issue #267): each runs as `sh -c <command>` in the
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

// §58 Enterprise Policy (issue #288): the documented flat `[policy]` surface.
// The parser accepts exactly these keys and normalizes them for the policy
// engine's own vocabulary (`layerPolicyFromConfig` in host/policy). Unknown
// keys fail closed and are named; a value the engine has no enforceable leaf
// for is still parsed and carried (`dataPolicy`, `loggingPolicy`) so doctor
// can report it rather than silently dropping it.
export interface PolicyAgentConfig {
  maxAgents?: number;
  maxCostUsd?: number;
}

export interface PolicyConfig {
  allowedModels?: string[];
  allowedProviders?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  // 'proxy' is the §58 spelling of the engine's 'allowlist' mode; the engine
  // mode names are accepted too so the two vocabularies meet in one place.
  networkPolicy?: string;
  allowedDomains?: string[];
  // 'workspace-only' is the §58 spelling of the engine's 'workspace-write'.
  filesystemPolicy?: string;
  requireCredentialBroker?: boolean;
  denyLocalCredentials?: boolean;
  dataPolicy?: string;
  loggingPolicy?: string;
  agentPolicy?: PolicyAgentConfig;
}

// §58 `[[audit]]` (parsed here; built in policy/audit-ledger.ts).
export interface AuditTableConfig {
  sink: string;
  level?: string;
  target?: string;
  // Review finding (issue #286): docs promise a name or a number 0–23.
  facility?: string | number;
}

export interface KubicConfig {
  agent?: AgentConfig;
  model?: ModelConfig;
  modes?: ModesConfig;
  approvals?: ApprovalsConfig;
  permissions?: PermissionsConfig;
  journal?: JournalConfig;
  roles?: Record<string, RoleConfig>;
  // Issue #237 (§29.2): a top-level `skills` array of files or
  // directories — NOT a `[skills]` section. Entries are stored as written
  // (relative stays relative); the config LOAD resolves each layer's
  // entries against that layer's file directory, so a project config's
  // relative entry anchors at the project, never the invoking cwd.
  skills?: string[];
  orchestrator?: OrchestratorConfig;
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
  'modes',
  'approvals',
  'permissions',
  'journal',
  'roles',
  'orchestrator',
  'ui',
  'session',
  'verify',
  'policy',
  'audit',
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

# Settings skills (issue #237; design §29.2): files or directories, resolved
# against this file's directory — "./skills" names "<root>/.kubic/skills"
# ("../skills" would name "<root>/skills").
skills = ["./skills"]

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

[verify]
tests = "npm test"
typecheck = "npm run typecheck"
timeoutMs = 600000

[policy]
allowed_models = ["local/*"]
allowed_providers = ["local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = []
network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]
filesystem_policy = "workspace-only"
require_credential_broker = true
deny_local_credentials = true
data_policy = "no-external-training"
logging_policy = "full-audit"
agent_policy = { max_agents = 2, max_cost_usd = 5.0 }

[[audit]]
sink = "syslog"
level = "privileged"
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

// §58's `agent_policy = { max_agents = 2, max_cost_usd = 5.0 }` (issue #288):
// a TOML inline table is the only nested shape the [policy] surface uses, so
// the parser supports exactly one level of it. Guarded like the section
// parser: dunder keys are refused and duplicates are named.
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

// `[[audit]]` (issue #288): append a fresh table to the array at `path` and
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
  // element for an `[[array-of-tables]]` header (issue #288).
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

// §35/§44 orchestrator worktree parent (issue #133): a workspace-relative
// directory — never an absolute path, never a `..` segment, never a
// trailing `/` — so the spawned set can never be steered outside the repo
// and the value can be used verbatim as an ignore entry. The runtime
// projection re-checks this rule because programmatic session/agent layers
// never pass through this parser.
//
// Hardening (issue #133 review; the metacharacter rule re-reviewed), all
// re-checked by the projection:
//   * control characters are refused by name — the value is shipped to
//     `.git/info/exclude` verbatim, so a newline would inject arbitrary
//     gitignore patterns (hiding files from `git add -A` and the pre-merge
//     clean-tree guard), and an ESC or bidi override would reach
//     operator-facing messages. The set is the shared one in
//     @kubic/exec's runtime-exclude module; the value is never echoed.
//   * gitignore metacharacters are refused by name (issue #133
//     re-review) — git reads the entry as a pattern, so `*`/`?`/`[`/`]`
//     would match paths other than the named directory (same hiding harm),
//     a leading `#` would turn the line into a comment, and a backslash
//     would escape the next character (a trailing one leaves an entry that
//     matches nothing). Refused, never escaped into a different rule.
//   * a root whose exclude entry (`<root>/`) would ignore the committed
//     half (`.kubic/config.toml`, `.kubic/roles/*.md`) is refused — the
//     worktree parent must never make D35's committed files invisible to
//     git. The segment compare is case-insensitive (issue #133
//     fix-cycle-3): git case-folds ignore patterns on a case-insensitive
//     filesystem (`core.ignorecase=true`, the macOS default), so `.KUBIC/`
//     hides the committed half exactly like `.kubic/` does.
//   * a root that names the workspace itself or carries a `.` segment is
//     refused by name (issue #133 fix-cycle-3): `.`, `./`, `foo/.` all
//     resolve to a directory the derived `<root>/` entry cannot match, so
//     the worktree set would stay unignored and the pre-merge clean-tree
//     guard would refuse every merge. Never normalized — the value the
//     operator wrote is the value that would ship.
const COMMITTED_CONFIG_DIR_SEGMENTS: readonly (readonly string[])[] = [
  ['.kubic'],
  ['.kubic', 'roles'],
];

// Segment-wise (never a string prefix), so `.kubic/roles-archive` is not
// mistaken for `.kubic/roles`, and equivalent spellings of the same
// directory (`.kubic//roles`, `.kubic/./roles`) are caught. The compare
// folds case per segment (issue #133 fix-cycle-3): git case-folds ignore
// patterns on a case-insensitive filesystem, so a case variant of the
// committed half hides exactly the same files.
function isCommittedConfigHalfRoot(value: string): boolean {
  const segments = value
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  return COMMITTED_CONFIG_DIR_SEGMENTS.some(
    (dir) =>
      segments.length === dir.length &&
      dir.every((segment, index) => segments[index].toLowerCase() === segment),
  );
}

// §35/§44 root path shape (issue #133 fix-cycle-3): workspace-relative only —
// never empty, never absolute, never climbing out with `..`, never ending in
// `/` (the exclude-entry derivation appends one). Exported because the
// derivation (apps/kubic/src/config-runtime.ts) re-checks the same rule for
// programmatic callers that never pass through this parser; both call sites
// refuse by the same name.
export function checkOrchestratorRootShape(
  value: string,
  keyPath: string,
): void {
  if (value.trim() === '') {
    throw new ConfigError(
      `'${keyPath}': 'root' must be a workspace-relative path`,
    );
  }
  if (
    value.startsWith('/') ||
    value.split('/').includes('..') ||
    value.endsWith('/')
  ) {
    throw new ConfigError(
      `'${keyPath}': 'root' must be a workspace-relative path (no leading '/', no '..' segments, no trailing '/')`,
    );
  }
}

// A `.` segment names the directory it sits in (issue #133 fix-cycle-3): `.`
// is the workspace itself, `./` matches nothing at all, and `foo/.` is
// spelled `foo`. The derived `<root>/` entry would then ignore nothing — the
// worktree set would stay untracked and the pre-merge clean-tree guard would
// refuse every merge. Refused by name, never normalized: the value the
// operator wrote is the value that would ship. Exported for the derivation's
// own re-check (programmatic callers).
export function checkOrchestratorRootNoOp(
  value: string,
  keyPath: string,
): void {
  if (value.split('/').includes('.')) {
    throw new ConfigError(
      `'${keyPath}': 'root' must not name the workspace or carry a '.' segment — the derived exclude entry would match nothing and the worktree set would stay unignored`,
    );
  }
}

export function checkOrchestratorRoot(
  value: unknown,
  keyPath: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(
      `'${keyPath}': 'root' must be a workspace-relative path`,
    );
  }
  checkOrchestratorRootShape(value, keyPath);
  if (hasUnsafeCharacters(value)) {
    throw new ConfigError(
      `'${keyPath}': 'root' must be a workspace-relative path (control characters are refused — the value is shipped to git's exclude file verbatim)`,
    );
  }
  if (hasGitignoreMetacharacters(value)) {
    throw new ConfigError(
      `'${keyPath}': 'root' must be a workspace-relative path (gitignore metacharacters are refused — the value is shipped to git's exclude file verbatim)`,
    );
  }
  checkCommittedConfigHalfRoot(value, keyPath);
  checkOrchestratorRootNoOp(value, keyPath);
  return value;
}

// D35: the exclude entry `<root>/` must never ignore the committed half
// (`.kubic/config.toml`, `.kubic/roles/*.md`). Exported for the runtime
// projection (apps/kubic/src/config-runtime.ts), which re-checks the same
// rule at the one exclude-entry derivation every consumer shares (issue
// #133 re-review): a programmatic caller that bypassed the config load can
// never hand the writer an entry that would hide the committed files.
export function checkCommittedConfigHalfRoot(
  value: string,
  keyPath: string,
): void {
  if (isCommittedConfigHalfRoot(value)) {
    throw new ConfigError(
      `'${keyPath}': 'root' must not cover the committed config half ('.kubic/config.toml', '.kubic/roles/*.md') — pick a runtime path like '.kubic/wt'`,
    );
  }
}

// §42.4 journal byte bound (issue #350): a positive integer or nothing. 0 is
// refused by name — it is not "retention off" (unset is), it is a bound
// nothing can fit, so every append would be refused and every tool write
// would fail as journal_failed. Refused here rather than clamped.
export function checkJournalMaxBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError("'journal': 'maxBytes' must be a positive integer");
  }
  return value;
}

// §45 worker cap (issue #133): a positive integer or nothing. A value that
// could never admit a worker is refused here, by name — never clamped into
// one silently. The scheduler's own validation stays as the second layer.
export function checkOrchestratorMaxWorkers(
  value: unknown,
  keyPath: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `'${keyPath}': 'maxWorkers' must be a positive integer`,
    );
  }
  return value;
}

// §12.1 per-role model pin (issue #133): a `provider/id` ref, never a bare
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

// §58 keys and their allowed values (issue #288). The engine vocabulary
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
  'require_credential_broker',
  'deny_local_credentials',
  'data_policy',
  'logging_policy',
  'agent_policy',
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
  const requireCredentialBroker = optBoolean(
    raw,
    'require_credential_broker',
    'policy',
  );
  const denyLocalCredentials = optBoolean(
    raw,
    'deny_local_credentials',
    'policy',
  );
  const dataPolicy = reqString(raw, 'data_policy', 'policy', true);
  const loggingPolicy = reqString(raw, 'logging_policy', 'policy', true);
  let agentPolicy: PolicyAgentConfig | undefined;
  const rawAgentPolicy = raw.agent_policy;
  if (rawAgentPolicy !== undefined) {
    if (!isRecord(rawAgentPolicy)) {
      throw new ConfigError("'policy.agent_policy' must be a table");
    }
    checkNoUnknown(
      rawAgentPolicy,
      new Set(['max_agents', 'max_cost_usd']),
      'policy.agent_policy',
    );
    const maxAgents = optNumber(
      rawAgentPolicy,
      'max_agents',
      'policy.agent_policy',
    );
    const maxCostUsd = optNumber(
      rawAgentPolicy,
      'max_cost_usd',
      'policy.agent_policy',
    );
    agentPolicy = {
      ...(maxAgents === undefined ? {} : { maxAgents }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    };
  }
  return {
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(allowedProviders === undefined ? {} : { allowedProviders }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(deniedTools === undefined ? {} : { deniedTools }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(filesystemPolicy === undefined ? {} : { filesystemPolicy }),
    ...(requireCredentialBroker === undefined
      ? {}
      : { requireCredentialBroker }),
    ...(denyLocalCredentials === undefined ? {} : { denyLocalCredentials }),
    ...(dataPolicy === undefined ? {} : { dataPolicy }),
    ...(loggingPolicy === undefined ? {} : { loggingPolicy }),
    ...(agentPolicy === undefined ? {} : { agentPolicy }),
  };
}

// `[[audit]]` (issue #288): each element names a sink kind and a level; a
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
    // Review finding (issue #286): docs promise a name or a number
    // 0–23, so a TOML number rides through as-is; a fractional or
    // out-of-range number is refused here, by name.
    const facilityRaw = entry['facility'];
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
  assertNoBudgetKeys(raw);
  for (const key of Object.keys(raw)) {
    // Issue #237: `skills` is a top-level array key, not a section.
    if (key !== 'skills' && !KNOWN_SECTIONS.has(key)) {
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
        new Set(['model', 'tools', 'requires']),
        `roles.${name}`,
      );
      const modelRef = checkRoleModelRef(spec.model, name);
      const tools = optStringArray(spec, 'tools', `roles.${name}`);
      const requires = optStringArray(spec, 'requires', `roles.${name}`);
      parsed[name] = {
        ...(modelRef === undefined ? {} : { model: modelRef }),
        ...(tools === undefined ? {} : { tools }),
        ...(requires === undefined ? {} : { requires }),
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
    const root = checkOrchestratorRoot(orchestrator.root, 'orchestrator');
    const maxWorkers = checkOrchestratorMaxWorkers(
      orchestrator.maxWorkers,
      'orchestrator',
    );
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
  // Issue #237 (§29.2): `skills = [...]` — files or directories. Kept
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

// Issue #237 (§29.2): resolve one layer's `skills` entries against the
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

// The `[policy]` TOML spelling of each PolicyConfig field (issue #288): the
// serializer must emit what the parser accepts, and the §58 surface is
// snake_case while the TS shape is camelCase. `agentPolicy` is emitted as
// its own sub-table, so it is not in this list.
type PolicyFlatField = Exclude<keyof PolicyConfig, 'agentPolicy'>;
const POLICY_TOML_KEYS: ReadonlyArray<[PolicyFlatField, string]> = [
  ['allowedModels', 'allowed_models'],
  ['allowedProviders', 'allowed_providers'],
  ['allowedTools', 'allowed_tools'],
  ['deniedTools', 'denied_tools'],
  ['networkPolicy', 'network_policy'],
  ['allowedDomains', 'allowed_domains'],
  ['filesystemPolicy', 'filesystem_policy'],
  ['requireCredentialBroker', 'require_credential_broker'],
  ['denyLocalCredentials', 'deny_local_credentials'],
  ['dataPolicy', 'data_policy'],
  ['loggingPolicy', 'logging_policy'],
];

export function serializeTomlConfig(config: KubicConfig): string {
  const lines: string[] = [];
  // Issue #237: the top-level `skills` array serializes before the first
  // table (TOML keys precede tables).
  if (config.skills !== undefined) {
    lines.push(
      `skills = [${config.skills.map((entry) => JSON.stringify(entry)).join(', ')}]`,
      '',
    );
  }
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
  if (config.verify !== undefined) {
    emitTable(lines, 'verify', config.verify as Record<string, unknown>);
  }
  if (config.policy !== undefined) {
    const { agentPolicy, ...rest } = config.policy;
    const record: Record<string, unknown> = {};
    for (const [field, tomlKey] of POLICY_TOML_KEYS) {
      const value = rest[field];
      if (value !== undefined) record[tomlKey] = value;
    }
    if (Object.keys(record).length > 0) emitTable(lines, 'policy', record);
    if (agentPolicy !== undefined) {
      emitTable(lines, 'policy.agent_policy', {
        ...(agentPolicy.maxAgents === undefined
          ? {}
          : { max_agents: agentPolicy.maxAgents }),
        ...(agentPolicy.maxCostUsd === undefined
          ? {}
          : { max_cost_usd: agentPolicy.maxCostUsd }),
      });
    }
  }
  if (config.audit !== undefined) {
    for (const entry of config.audit) {
      lines.push('[[audit]]');
      const record = entry as unknown as Record<string, unknown>;
      for (const key of Object.keys(record).sort()) {
        lines.push(`${key} = ${formatValue(record[key])}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
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
          `project-local config refused pre-trust: ${path} — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation`,
        );
      }
      continue;
    }
    if (!bridge.exists(path)) continue;
    try {
      inputs.push({
        layer,
        // Issue #237: relative `skills` entries anchor at this file.
        config: resolveConfigSkills(
          parseTomlConfig(bridge.readTextFile(path)),
          path,
        ),
        ...(layer === 'project' ? { trusted: true as const } : {}),
      });
    } catch (error) {
      withLayerContext(layer, error);
    }
  }
  return mergeLayered(inputs);
}

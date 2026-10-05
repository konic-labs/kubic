// Per-role tool filtering + policy validation (issue #43; §12.1, §40,
// §35.1/58, §59.1). Roles filter by absence: a role's lane never
// registers what the role must not have (setActiveTools allowlist), and
// contradictory role definitions are refused at startup with named
// reasons surfaced through doctor. File access (if any) arrives as an
// exec FileBridge — this module never touches node:fs directly. Tests
// use inline fixture role documents, never real filesystem roles (role
// contents land in issue #44).

import type { PermissionClasses } from '../../../agents/src/policy.js';
import {
  CREDENTIAL_LEVELS,
  checkAgreement,
  FILESYSTEM_LEVELS,
  GIT_LEVELS,
  NETWORK_LEVELS,
  SHELL_LEVELS,
  toolsForClasses,
  validateClasses,
} from '../../../agents/src/policy.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import type { ConfigLayer, RoleModelEntry } from '../config/config.js';
import { CONFIG_LAYERS } from '../config/config.js';
import type { DoctorCheck } from '../doctor.js';
import {
  assertToolGrantable,
  type EffectivePolicy,
  hasToolPolicy,
  PolicyDeniedError,
} from '../policy/enterprise.js';
import { MAX_RUN_TIMEOUT_MS } from '../run-cli.js';

export class RoleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleParseError';
  }
}

export interface RoleToolPolicy {
  filesystem?: unknown;
  shell?: unknown;
  network?: unknown;
  git?: unknown;
  credentials?: unknown;
}

export interface ParsedRoleDoc {
  name: string;
  // Issue #198 (§12, Pi-agent shape): `description` is shown by doctor.
  description?: string;
  // Issue #198 (§12): the document's own `provider/id` model pin — the
  // lowest model tier (spawn/CLI > config `[roles.<r>]` > document).
  // Validated at parse, so a malformed ref is refused by name everywhere.
  model?: string;
  // Issue #198 (§71): the document's own budget dims (the --budget set) —
  // applies to a spawned worker only when present, and only when no
  // spawn/CLI budget outranks it. Validated at parse, like --budget.
  budget?: Record<string, number>;
  tools?: string[];
  // Issue #181 (§29.4): the skills this role sees, by skill name. Absent
  // means no restriction (every gated-visible skill is offered); a
  // declared list restricts the visible set to its names.
  skills?: string[];
  // Issue #196 (§41.1): tool names that always require approval under
  // this role (`requires: [write]`). Absent means none — the triggers
  // alone decide.
  requires?: string[];
  classes: RoleToolPolicy;
}

const CLASS_KEYS = new Set([
  'filesystem',
  'shell',
  'network',
  'git',
  'credentials',
]);

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseToolsList(raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith('[') && inner.endsWith(']')) {
    inner = inner.slice(1, -1);
  }
  return inner
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry !== '');
}

// The document-budget dimension set (issue #198): exactly the --budget
// dims (orchestrate-cli BUDGET_DIMENSIONS) — a document can never invent
// a dimension the spawn gate would not enforce. `retryBudget` is not one:
// --budget does not accept it either.
const DOCUMENT_BUDGET_DIMENSIONS: ReadonlySet<string> = new Set([
  'maxTokens',
  'maxCostUsd',
  'maxRuntimeMs',
  'maxToolCalls',
]);

// A document `budget = { maxToolCalls = 5, maxCostUsd = 2 }` value (issue
// #198): the shipped `.kubic/roles/*.md` examples already spell dims with
// `=` (a `:` inside the braces would split the frontmatter line itself, so
// only `=` is accepted). Same rules as --budget: known dims only, finite
// positive numbers, maxRuntimeMs under the setTimeout ceiling (run-cli
// MAX_RUN_TIMEOUT_MS — above it the watchdog would fire almost
// immediately and misreport limit=wallClock). Empty braces mean absent.
function parseDocumentBudget(
  raw: string,
  roleName: string,
): Record<string, number> | undefined {
  let inner = raw;
  if (inner.startsWith('{') && inner.endsWith('}')) {
    inner = inner.slice(1, -1);
  }
  const dims: Record<string, number> = {};
  for (const part of inner.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) {
      throw new RoleParseError(
        `role '${roleName}': 'budget' dims must be 'name = number' (got ${JSON.stringify(trimmed)})`,
      );
    }
    const dim = trimmed.slice(0, equals).trim();
    const value = Number(trimmed.slice(equals + 1));
    if (!DOCUMENT_BUDGET_DIMENSIONS.has(dim)) {
      throw new RoleParseError(
        `role '${roleName}': unknown budget dimension '${dim}' (one of ${[...DOCUMENT_BUDGET_DIMENSIONS].join(', ')})`,
      );
    }
    if (!Number.isFinite(value) || !(value > 0)) {
      throw new RoleParseError(
        `role '${roleName}': budget '${dim}' must be a positive number (got ${JSON.stringify(trimmed.slice(equals + 1).trim())})`,
      );
    }
    if (dim === 'maxRuntimeMs' && value > MAX_RUN_TIMEOUT_MS) {
      throw new RoleParseError(
        `role '${roleName}': budget 'maxRuntimeMs' must be no more than ${MAX_RUN_TIMEOUT_MS}`,
      );
    }
    dims[dim] = value;
  }
  return Object.keys(dims).length === 0 ? undefined : dims;
}

// Frontmatter contract (role contents land in issue #44 — this is the
// shape they must honor): a `---`-delimited block of `key: value` (or
// `key = value`) lines. `role` names the role, `tools` is a `[a, b]`
// (or bare `a, b`) list, `skills` is a `[a, b]` list of the skill names
// this role sees (absent means unrestricted, issue #181), `requires` is a
// `[a, b]` list of tool names that always require approval under this role
// (absent means none, issue #196), and the five permission-class keys carry
// the tool_policy. Unknown keys are refused fail-closed, never ignored.
export function parseRoleDocument(markdown: string): ParsedRoleDoc {
  // Issue #236: normalize Windows line endings (and strip a leading
  // BOM) before fence detection — otherwise a `---\r` closing fence
  // never matches `indexOf('---')` and the doc is refused as unclosed.
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new RoleParseError(
      'role document must open with a --- frontmatter block',
    );
  }
  const close = lines.indexOf('---', 1);
  if (close === -1) {
    throw new RoleParseError(
      'role document frontmatter is never closed (missing ---)',
    );
  }
  let name: string | undefined;
  let alias: string | undefined;
  let description: string | undefined;
  let modelRaw: string | undefined;
  let budgetRaw: string | undefined;
  let tools: string[] | undefined;
  let skills: string[] | undefined;
  let requires: string[] | undefined;
  const classes: RoleToolPolicy = {};
  for (const line of lines.slice(1, close)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const sep = trimmed.includes(':')
      ? ':'
      : trimmed.includes('=')
        ? '='
        : null;
    if (sep === null) {
      throw new RoleParseError(
        `unparseable frontmatter line: ${JSON.stringify(line)}`,
      );
    }
    const key = trimmed.slice(0, trimmed.indexOf(sep)).trim();
    const raw = trimmed.slice(trimmed.indexOf(sep) + 1);
    if (key === 'role') {
      name = String(parseScalar(raw));
    } else if (key === 'name') {
      // Issue #198 (§12): Pi-agent alias of `role` — a second name for
      // the same document, refused when the two disagree.
      alias = String(parseScalar(raw));
    } else if (key === 'description') {
      description = String(parseScalar(raw));
    } else if (key === 'model') {
      modelRaw = String(parseScalar(raw));
    } else if (key === 'budget') {
      budgetRaw = raw.trim();
    } else if (key === 'tools') {
      tools = parseToolsList(raw);
    } else if (key === 'skills') {
      skills = parseToolsList(raw);
    } else if (key === 'requires') {
      requires = parseToolsList(raw);
    } else if (CLASS_KEYS.has(key)) {
      classes[key as keyof RoleToolPolicy] = parseScalar(raw);
    } else {
      throw new RoleParseError(`unknown frontmatter key '${key}'`);
    }
  }
  if (name === undefined || name === '') {
    if (alias === undefined || alias === '') {
      throw new RoleParseError(
        "role document frontmatter must declare 'role' (or its Pi-agent alias 'name')",
      );
    }
    name = alias;
  } else if (alias !== undefined && alias !== '' && alias !== name) {
    throw new RoleParseError(
      `'role' (${JSON.stringify(name)}) disagrees with 'name' (${JSON.stringify(alias)}): one document, one role`,
    );
  }
  // The document model pin (issue #198): `provider/id`, both sides
  // non-empty — the same rule the config `[roles.<r>].model` check and
  // the runtime `roleModelSelection` enforce, so a malformed ref is
  // refused here with its reason instead of reaching a lane.
  let model: string | undefined;
  if (modelRaw !== undefined) {
    const slash = modelRaw.indexOf('/');
    if (slash <= 0 || slash === modelRaw.length - 1) {
      throw new RoleParseError(
        `role '${name}': 'model' must be 'provider/id' (got ${JSON.stringify(modelRaw)})`,
      );
    }
    model = modelRaw;
  }
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(budgetRaw === undefined
      ? {}
      : { budget: parseDocumentBudget(budgetRaw, name) }),
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(requires === undefined ? {} : { requires }),
    classes,
  };
}

export class RoleRefusedError extends Error {
  constructor(role: string, reason: string) {
    super(`role '${role}' refused: ${reason}`);
    this.name = 'RoleRefusedError';
  }
}

// The known tool universe is derived from the same class→tool mapping
// the lane enforces (agents policy), never a second hand-kept list.
const FULL_CLASSES: PermissionClasses = {
  filesystem: 'full',
  shell: true,
  network: 'full',
  git: 'full',
  credentials: 'allowlist',
};

export const KNOWN_ROLE_TOOLS: readonly string[] =
  toolsForClasses(FULL_CLASSES);

export interface RoleLayerSpec {
  tools?: string[];
  classes?: RoleToolPolicy;
  // Issue #196 (§41.1): the layer's per-role approval obligations, the
  // same shape `[roles.<name>].requires` declares. Merged by union with
  // the document's list (every named tool requires approval).
  requires?: string[];
  // The layer's per-role model pin (issue #133): `provider/id`, the same
  // shape `[roles.<name>].model` declares. The role document itself has no
  // model key — the layers are where a model pin comes from.
  model?: string;
  // The layer's per-role thinking default (issue #225; §12.1/§63).
  thinking?: string;
  // The layer's per-role allowed model set (issue #255; §38.2):
  // normalized entries, whole-list first-wins like `tools`.
  models?: RoleModelEntry[];
}

export interface RoleLayerInput {
  layer: ConfigLayer;
  roles: Record<string, RoleLayerSpec>;
}

export interface MergedRole {
  tools: string[] | undefined;
  classes: PermissionClasses;
  // Issue #196 (§41.1): the union of the document's `requires` and every
  // layer's — every named tool requires approval under this role.
  requires: string[];
  // Issue #198 (§12): the document's description, shown by doctor.
  description?: string;
  // The layer-supplied `provider/id` pin (issue #133), or the document's
  // own pin (issue #198) when no layer sets one — the run path then keeps
  // its own selection default only when neither sets one.
  model: string | undefined;
  // Issue #198 (§71): the document's own budget dims, if it declares
  // any — no layer tier exists, so this passes through untouched.
  budget?: Record<string, number>;
  thinking: string | undefined;
  // The winning allowed set (issue #255; §38.2), or undefined when no
  // layer set one — the role then allows all models.
  models: RoleModelEntry[] | undefined;
  overriddenAttempts: string[];
}

const CLASS_ORDER: Array<keyof PermissionClasses> = [
  'filesystem',
  'shell',
  'network',
  'git',
  'credentials',
];

// tool_policy merge (§35.1/58): layers run enterprise→agent and the
// first layer to set a leaf wins — a lower layer can never override a
// key set above it. The role document is the fallback base below every
// layer. Overridden attempts are reported, never applied (mirrors
// mergeLayered in host config).
export function mergeRoleLayers(
  doc: ParsedRoleDoc,
  inputs: RoleLayerInput[],
): MergedRole {
  const ordered = [...inputs].sort(
    (a, b) => CONFIG_LAYERS.indexOf(a.layer) - CONFIG_LAYERS.indexOf(b.layer),
  );
  const overriddenAttempts: string[] = [];
  let tools: string[] | undefined;
  let model: string | undefined;
  // Issue #196 (§41.1): approval obligations only ever accumulate — the
  // document's list plus every layer's, deduped and sorted for a
  // deterministic grant. A layer can add obligations, never remove them.
  const required = new Set<string>(doc.requires ?? []);
  let thinking: string | undefined;
  // Whole-list first-wins (issue #255): the highest layer that sets a
  // set wins it outright (tools precedent) — a lower layer's list never
  // unions in, so the winning layer's boundary stays exact.
  let models: RoleModelEntry[] | undefined;
  const classLeaves = new Map<string, unknown>();
  for (const input of ordered) {
    const spec = input.roles[doc.name];
    if (spec === undefined) continue;
    if (spec.tools !== undefined) {
      if (tools === undefined) {
        tools = [...spec.tools];
      } else if (JSON.stringify(tools) !== JSON.stringify(spec.tools)) {
        overriddenAttempts.push(`roles.${doc.name}.tools`);
      }
    }
    if (spec.model !== undefined) {
      if (model === undefined) {
        model = spec.model;
      } else if (model !== spec.model) {
        overriddenAttempts.push(`roles.${doc.name}.model`);
      }
    }
    if (spec.requires !== undefined) {
      for (const tool of spec.requires) required.add(tool);
    }
    if (spec.thinking !== undefined) {
      if (thinking === undefined) {
        thinking = spec.thinking;
      } else if (thinking !== spec.thinking) {
        overriddenAttempts.push(`roles.${doc.name}.thinking`);
      }
    }
    if (spec.models !== undefined) {
      if (models === undefined) {
        models = spec.models.map((entry) => ({ ...entry }));
      } else if (JSON.stringify(models) !== JSON.stringify(spec.models)) {
        overriddenAttempts.push(`roles.${doc.name}.models`);
      }
    }
    if (spec.classes !== undefined) {
      for (const key of CLASS_ORDER) {
        const value = spec.classes[key];
        if (value === undefined) continue;
        const path = `roles.${doc.name}.tool_policy.${key}`;
        if (!classLeaves.has(key)) {
          classLeaves.set(key, value);
        } else if (
          JSON.stringify(classLeaves.get(key)) !== JSON.stringify(value)
        ) {
          overriddenAttempts.push(path);
        }
      }
    }
  }
  const rawClasses: Record<string, unknown> = {
    ...(doc.classes as Record<string, unknown>),
  };
  // Issue #198: the document pin is the fallback tier under every layer —
  // a layer winning over the document is precedence (the documented
  // spawn/CLI > config > document order), never an overridden attempt.
  if (model === undefined) model = doc.model;
  for (const [key, value] of classLeaves) {
    rawClasses[key] = value;
  }
  return {
    tools: tools ?? doc.tools,
    classes: validateClasses(rawClasses),
    requires: [...required].sort(),
    ...(doc.description === undefined ? {} : { description: doc.description }),
    model,
    ...(doc.budget === undefined ? {} : { budget: { ...doc.budget } }),
    thinking,
    models,
    overriddenAttempts,
  };
}

// Effective classes (issue #196, §40.2): the most restrictive merge of
// the config classes and the role's — per key, the tighter level wins.
// The level lists run least→most permissive (agents policy), so the merge
// is the per-key minimum index. A role can only narrow the lane, never
// widen it — `network: none` on the role beats `network: full` in config,
// and a role without an opinion changes nothing.
export function effectiveRoleClasses(
  config: PermissionClasses,
  role: PermissionClasses,
): PermissionClasses {
  const pick = <T>(order: readonly T[], a: T, b: T): T =>
    order.indexOf(a) <= order.indexOf(b) ? a : b;
  return {
    filesystem: pick(FILESYSTEM_LEVELS, config.filesystem, role.filesystem),
    shell: pick(SHELL_LEVELS, config.shell, role.shell),
    network: pick(NETWORK_LEVELS, config.network, role.network),
    git: pick(GIT_LEVELS, config.git, role.git),
    credentials: pick(CREDENTIAL_LEVELS, config.credentials, role.credentials),
  };
}

export interface ResolvedRole {
  name: string;
  // Deterministic order: deduped, lexicographically sorted — resolving
  // identical definitions always yields an identically-ordered list.
  tools: string[];
  classes: PermissionClasses;
  // Issue #196 (§41.1): tool names that always require approval under
  // this role — the union of the document's `requires` and every layer's,
  // threaded into the installed policy's trigger context. Empty when none.
  requires: string[];
  // Issue #198 (§12): the document's description, shown by doctor.
  description?: string;
  // The layer-supplied `provider/id` pin (issue #133), or the document's
  // own pin (issue #198) when no layer sets one — the run path then keeps
  // its own selection default only when neither sets one.
  model: string | undefined;
  // Issue #198 (§71): the document's own budget dims, if it declares
  // any — no layer tier exists, so this passes through untouched.
  budget?: Record<string, number>;
  // The layer-supplied thinking default (issue #225), or undefined.
  thinking: string | undefined;
  // The layer-supplied allowed model set (issue #255; §38.2), or
  // undefined when no layer set one — the role then allows all models.
  models: RoleModelEntry[] | undefined;
  overriddenAttempts: string[];
}

// The allowed set's matcher (issue #255; §38.2): an absent or empty set
// allows all; otherwise the `provider/id` must match an entry exactly or
// sit under a `provider/*` entry. The wildcard keeps its slash, so
// `local/*` never matches `localfoo/x`.
export function roleModelAllowed(
  models: readonly RoleModelEntry[] | undefined,
  provider: string,
  id: string,
): boolean {
  // Absent or empty allows all (issue #255): only a non-empty set
  // constrains, so `models = []` and an unset key behave identically.
  if (models === undefined || models.length === 0) return true;
  return roleModelEntry(models, provider, id) !== undefined;
}

// The first entry covering `provider/id` (issue #255): exact entries
// before wildcard ones is the caller's order, not this function's — the
// first match wins, so overlapping entries resolve deterministically.
export function roleModelEntry(
  models: readonly RoleModelEntry[] | undefined,
  provider: string,
  id: string,
): RoleModelEntry | undefined {
  if (models === undefined || models.length === 0) return undefined;
  const ref = `${provider}/${id}`;
  return models.find(
    (entry) =>
      entry.id === ref ||
      (entry.id.endsWith('/*') && ref.startsWith(entry.id.slice(0, -1))),
  );
}

export interface ResolveOptions {
  validate?: boolean;
  /**
   * §58 enterprise policy (issue #288): a role grant funnels through
   * `assertToolGrantable`, so a role document (or a layer) that declares a
   * denied tool is REFUSED by name — never silently widened, and never
   * re-enabled because a role asked. Absent means no enterprise tool policy
   * is configured; a policy with no tool gate leaves roles untouched.
   */
  toolPolicy?: EffectivePolicy;
}

export function resolveRole(
  doc: ParsedRoleDoc,
  inputs: RoleLayerInput[],
  options: ResolveOptions = {},
): ResolvedRole {
  const merged = mergeRoleLayers(doc, inputs);
  const tools = [
    ...new Set(merged.tools ?? toolsForClasses(merged.classes)),
  ].sort();
  const resolved: ResolvedRole = {
    name: doc.name,
    tools,
    classes: merged.classes,
    requires: merged.requires,
    ...(merged.description === undefined
      ? {}
      : { description: merged.description }),
    model: merged.model,
    ...(merged.budget === undefined ? {} : { budget: merged.budget }),
    thinking: merged.thinking,
    // Copied, never shared: the caller owns the resolved set.
    models:
      merged.models === undefined
        ? undefined
        : merged.models.map((entry) => ({ ...entry })),
    overriddenAttempts: merged.overriddenAttempts,
  };
  const toolPolicy = options.toolPolicy;
  if (toolPolicy !== undefined && hasToolPolicy(toolPolicy)) {
    for (const tool of resolved.tools) {
      try {
        assertToolGrantable(toolPolicy, tool, {
          layer: 'agent',
          role: resolved.name,
        });
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          throw new RoleRefusedError(resolved.name, error.message);
        }
        throw error;
      }
    }
  }
  if (options.validate !== false) validateResolvedRole(resolved);
  return resolved;
}

// Mismatch validator (§40.3, §59.1): a declared tool set that
// contradicts its classes — e.g. filesystem 'read' with a write tool —
// is refused with a named reason, never silently narrowed. Unknown
// tools are refused the same way: policy, not enforcement, owns the
// vocabulary, and the lane must never register what it cannot name.
export function validateResolvedRole(resolved: ResolvedRole): void {
  for (const tool of resolved.tools) {
    if (!(KNOWN_ROLE_TOOLS as readonly string[]).includes(tool)) {
      throw new RoleRefusedError(
        resolved.name,
        `unknown tool '${tool}' (not in the registered tool set)`,
      );
    }
  }
  const agreement = checkAgreement(resolved.classes, resolved.tools);
  if (!agreement.agree) {
    throw new RoleRefusedError(resolved.name, agreement.reason);
  }
}

// Lane filter: the lane allow-list narrows to exactly the resolved role
// set via setActiveTools — never-registered tools are uncallable by
// construction. Validation runs first so a contradictory role is
// refused before the lane is touched. An empty tool set allow-lists
// nothing (the noTools case).
export interface RoleLane {
  setActiveTools(tools: string[], context: unknown): void | Promise<void>;
}

export async function applyRoleToLane(
  lane: RoleLane,
  resolved: ResolvedRole,
  context: unknown,
): Promise<string[]> {
  validateResolvedRole(resolved);
  await lane.setActiveTools(resolved.tools, context);
  return resolved.tools;
}

export interface BeforeToolEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type BeforeToolVerdict =
  | { block: { reason: string; terminate: false } }
  | undefined;

// Absence guard (§40 set): calls to tools the role never registered
// fail tool-absent. This is not approval-gated — the reason names the
// absence, never an approval capability, so no decider is consulted.
export function createRoleToolGuard(
  role: string,
  allowed: readonly string[],
): (event: BeforeToolEvent) => BeforeToolVerdict {
  return (event) => {
    if (allowed.includes(event.toolName)) return undefined;
    return {
      block: {
        reason: `tool-absent: tool '${event.toolName}' is not registered for role '${role}'`,
        terminate: false as const,
      },
    };
  };
}

// Debug line (§50): the existing [policy] vocabulary names the role and
// its resolved tool set — no new line class is introduced.
export function roleDebugLine(resolved: ResolvedRole): string {
  return `[policy] role=${resolved.name} tools=${resolved.tools.join(',')}`;
}

export function emitRoleDebug(
  sink: (line: string) => void,
  resolved: ResolvedRole,
): void {
  sink(roleDebugLine(resolved));
}

// Doctor surfacing (§41.4, §50): every resolved role becomes a
// `role:<name>` check. Contradictory roles report fail/policy-mismatch
// with the refusal reason — the same shape runDoctorCommand renders,
// without touching the doctor module.
// Issue #196 (§40.2): the doctor's effective-classes rendering — the five
// levels in class order, so the run's posture is one comparable line.
function formatEffectiveClasses(classes: PermissionClasses): string {
  return `filesystem:${String(classes.filesystem)} shell:${String(classes.shell)} network:${classes.network} git:${String(classes.git)} credentials:${classes.credentials}`;
}

export function roleDoctorChecks(
  resolvedRoles: ResolvedRole[],
  // Where each role's winning document came from (issue #203): the preset
  // bundled with the binary, or a `.kubic/roles/<name>.md` that overrode it.
  // Absent means the caller does not know — the detail then omits the layer.
  sources: Record<string, string> = {},
  // Issue #196 (§40.2): the run's config classes. Present means the detail
  // names the EFFECTIVE classes (most restrictive merge with the role's)
  // the lane would install — absent keeps the role's own tool list.
  configClasses?: PermissionClasses,
): DoctorCheck[] {
  return resolvedRoles.map((resolved) => {
    const base = {
      id: `role:${resolved.name}`,
      label: `role ${resolved.name}`,
    };
    try {
      validateResolvedRole(resolved);
    } catch (error) {
      return {
        ...base,
        status: 'fail' as const,
        reason: 'policy-mismatch' as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ...base,
      status: 'pass' as const,
      reason: 'ok' as const,
      // Issue #198 (§12): the document description, when the role
      // declares one — right after the source, before the tool/effective
      // detail, in both detail shapes.
      detail:
        configClasses === undefined
          ? `${sources[resolved.name] ?? 'builtin'} role${resolved.description === undefined ? '' : ` — ${resolved.description}`} — ${resolved.tools.length} tool(s): ${resolved.tools.join(', ')}`
          : `${sources[resolved.name] ?? 'builtin'} role${resolved.description === undefined ? '' : ` — ${resolved.description}`} — effective ${formatEffectiveClasses(effectiveRoleClasses(configClasses, resolved.classes))}${resolved.requires.length === 0 ? '' : ` — requires approval: ${resolved.requires.join(', ')}`}`,
    };
  });
}

// Role document load through the exec FileBridge (sorted by filename so
// multi-role loads are deterministic). The bridge is injected so tests
// run on fakes while prod passes the real FileBridge.
export function loadRoleDocuments(
  bridge: Pick<FileBridge, 'listDir' | 'readTextFile'>,
  dir: string,
): ParsedRoleDoc[] {
  return bridge
    .listDir(dir)
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => parseRoleDocument(bridge.readTextFile(entry.path)));
}

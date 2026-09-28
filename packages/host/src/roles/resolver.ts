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
  checkAgreement,
  toolsForClasses,
  validateClasses,
} from '../../../agents/src/policy.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../../worker/src/lane/interceptors.js';
import type { TriggerContext } from '../approvals.js';
import { detectTriggers } from '../approvals.js';
import type { ConfigLayer } from '../config/config.js';
import { CONFIG_LAYERS } from '../config/config.js';
import type { DoctorCheck } from '../doctor.js';
import {
  assertToolGrantable,
  type EffectivePolicy,
  hasToolPolicy,
  PolicyDeniedError,
} from '../policy/enterprise.js';

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
  tools?: string[];
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

// Frontmatter contract (role contents land in issue #44 — this is the
// shape they must honor): a `---`-delimited block of `key: value` (or
// `key = value`) lines. `role` names the role, `tools` is a `[a, b]`
// (or bare `a, b`) list, and the five permission-class keys carry the
// tool_policy. Unknown keys are refused fail-closed, never ignored.
export function parseRoleDocument(markdown: string): ParsedRoleDoc {
  const lines = markdown.split('\n');
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
  let tools: string[] | undefined;
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
    } else if (key === 'tools') {
      tools = parseToolsList(raw);
    } else if (CLASS_KEYS.has(key)) {
      classes[key as keyof RoleToolPolicy] = parseScalar(raw);
    } else {
      throw new RoleParseError(`unknown frontmatter key '${key}'`);
    }
  }
  if (name === undefined || name === '') {
    throw new RoleParseError("role document frontmatter must declare 'role'");
  }
  return { name, ...(tools === undefined ? {} : { tools }), classes };
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
  // The layer's per-role model pin (issue #133): `provider/id`, the same
  // shape `[roles.<name>].model` declares. The role document itself has no
  // model key — the layers are where a model pin comes from.
  model?: string;
}

export interface RoleLayerInput {
  layer: ConfigLayer;
  roles: Record<string, RoleLayerSpec>;
}

export interface MergedRole {
  tools: string[] | undefined;
  classes: PermissionClasses;
  model: string | undefined;
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
  for (const [key, value] of classLeaves) {
    rawClasses[key] = value;
  }
  return {
    tools: tools ?? doc.tools,
    classes: validateClasses(rawClasses),
    model,
    overriddenAttempts,
  };
}

export interface ResolvedRole {
  name: string;
  // Deterministic order: deduped, lexicographically sorted — resolving
  // identical definitions always yields an identically-ordered list.
  tools: string[];
  classes: PermissionClasses;
  // The layer-supplied `provider/id` pin (issue #133), or undefined when no
  // layer set one — the run path then keeps its own selection default.
  model: string | undefined;
  overriddenAttempts: string[];
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
    model: merged.model,
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

export interface RolePolicyGuardOptions {
  workspace: string;
  network: 'none' | 'allowlist' | 'full';
}

// before_tool policy guard (§40/§41): destructive, network, push,
// install, and outside-workspace calls block with terminate:false and a
// reason naming the capability — the block routes to approval (the
// challenged path stands the guards down for exactly that call), it is
// not a deny. Classification reuses the host approval triggers and the
// worker classifiers, never a second matcher.
export function createRolePolicyGuard(
  role: string,
  options: RolePolicyGuardOptions,
): (event: BeforeToolEvent) => BeforeToolVerdict {
  const ctx: TriggerContext = {
    workspace: options.workspace,
    network: options.network,
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path) =>
      confinePath(options.workspace, path).rewritten,
  };
  return (event) => {
    const capabilities = detectTriggers(event.toolName, event.args, ctx);
    if (capabilities.length === 0) return undefined;
    return {
      block: {
        reason: `${capabilities.join(', ')} requires approval for role '${role}'`,
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
export function roleDoctorChecks(resolvedRoles: ResolvedRole[]): DoctorCheck[] {
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
      detail: `${resolved.tools.length} tool(s): ${resolved.tools.join(', ')}`,
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

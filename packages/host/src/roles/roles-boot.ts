// Role documents on the live path (issue #99, scope item 1; §12/§12.1,
// §40.3, §41.4). The resolver (issue #43) owns parsing, layering and the
// agreement check; this module is the boot seam that actually calls it —
// loads `.kubic/roles/*.md` through the exec FileBridge, refuses a
// contradictory role by name, projects the loaded set onto doctor, and
// hands the resolved role's tool set + prompt text to a lane boot.
//
// I/O confinement: this module never imports node:fs. The bridge is
// injected, so tests drive fixtures while prod passes the real FileBridge.
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import type { DoctorCheck } from '../doctor.js';
import type { RoleLayerInput } from './resolver.js';
import {
  applyRoleToLane,
  KNOWN_ROLE_TOOLS,
  loadRoleDocuments,
  type ParsedRoleDoc,
  type ResolvedRole,
  type RoleLane,
  RoleParseError,
  RoleRefusedError,
  resolveRole,
  roleDoctorChecks,
  validateResolvedRole,
} from './resolver.js';

export const ROLES_DIR = '.kubic/roles';

// The document path for a role name: `.kubic/roles/<name>.md` under the
// workspace. Pure join, no fs access — the bridge reads it.
export function roleDocPath(cwd: string, name: string): string {
  return `${cwd}/${ROLES_DIR}/${name}.md`;
}

export class RoleBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleBootError';
  }
}

export interface RolesDirInput {
  bridge: FileBridge;
  cwd: string;
}

export interface LoadedRoles {
  docs: ParsedRoleDoc[];
  resolved: ResolvedRole[];
  // Documents that parsed but were refused (§40.3) — reported, never
  // silently dropped: a contradictory role is exactly what doctor must
  // show. Keyed by role name.
  refused: Array<{ name: string; reason: string }>;
}

// Every .md under .kubic/roles, parsed and resolved. A parse failure is
// named with the document's own path so a typo'd frontmatter cannot be
// mistaken for "no roles configured". A refusal (§40.3) is NOT fatal here
// — the set is reported so doctor can fail it; the lane boot is where a
// refused role stops a run.
export function loadRoles(input: RolesDirInput): LoadedRoles {
  const dir = `${input.cwd}/${ROLES_DIR}`;
  let docs: ParsedRoleDoc[];
  try {
    docs = loadRoleDocuments(input.bridge, dir);
  } catch (error) {
    if (error instanceof RoleParseError) {
      throw new RoleBootError(
        `role document under ${ROLES_DIR} is invalid: ${error.message}`,
      );
    }
    throw error;
  }
  const resolved: ResolvedRole[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const doc of docs) {
    try {
      resolved.push(resolveRole(doc, []));
    } catch (error) {
      if (error instanceof RoleRefusedError) {
        refused.push({ name: doc.name, reason: error.message });
        continue;
      }
      throw error;
    }
  }
  return { docs, resolved, refused };
}

// The role a lane boot runs as. `--role` names it; an absent flag means no
// role (the solo default, unchanged). Fail-closed: an unknown role, a
// document that failed to parse, or a contradiction refuses the run with a
// named reason — never an invented fallback.
export interface RoleSelectionInput extends RolesDirInput {
  role: string;
  // §35.1/§58 layering: layer-supplied tool_policy/tools over the document.
  // Empty in the shipped binary (no config layer populates roles yet).
  layers?: RoleLayerInput[];
}

export interface SelectedRole {
  resolved: ResolvedRole;
  doc: ParsedRoleDoc;
}

export function selectRole(input: RoleSelectionInput): SelectedRole {
  const loaded = loadRoles(input);
  const doc = loaded.docs.find((entry) => entry.name === input.role);
  if (doc === undefined) {
    const known = loaded.docs.map((entry) => entry.name).join(', ');
    throw new RoleBootError(
      `no role document for '${input.role}' under ${ROLES_DIR}${known === '' ? ' (no role documents found)' : ` (loaded: ${known})`}`,
    );
  }
  const resolved = resolveRole(doc, input.layers ?? []);
  return { resolved, doc };
}

// §12.1/§40.3 on the lane: the role's resolved tool set becomes the lane's
// allowlist (absence, not approval, withholds a tool) and the role's prompt
// text replaces the solo constant. Both halves are the resolver's own
// values — this function invents nothing.
//
// The prompt half composes the document's `## Prompt` body: the
// frontmatter is the policy, the body is the instruction. A document with
// no `## Prompt` section is refused by name rather than booting an
// instruction-less role.
export function rolePromptFor(doc: ParsedRoleDoc, markdown: string): string {
  const marker = /^##\s+Prompt\s*$/m.exec(markdown);
  if (marker === null) {
    throw new RoleBootError(
      `role '${doc.name}' has no '## Prompt' section: refusing a role with no instructions`,
    );
  }
  const body = markdown.slice(marker.index + marker[0].length);
  const nextSection = /^##\s+/m.exec(body);
  const text = (
    nextSection === null ? body : body.slice(0, nextSection.index)
  ).trim();
  if (text === '') {
    throw new RoleBootError(
      `role '${doc.name}' has an empty '## Prompt' section: refusing a role with no instructions`,
    );
  }
  return text;
}

// Doctor projection (§41.4, §50): one `role:<name>` check per resolved
// role, plus a named failure for every document that parsed but was
// refused — so a contradiction is visible in `kubic doctor` even though
// the lane is a different process.
export function rolesDoctorProbe(input: RolesDirInput): DoctorCheck[] {
  let loaded: LoadedRoles;
  try {
    loaded = loadRoles(input);
  } catch (error) {
    return [
      {
        id: 'role:documents',
        label: 'role documents',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  const checks = roleDoctorChecks(loaded.resolved);
  for (const refusal of loaded.refused) {
    checks.push({
      id: `role:${refusal.name}`,
      label: `role ${refusal.name}`,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: refusal.reason,
    });
  }
  if (checks.length === 0) {
    checks.push({
      id: 'role:documents',
      label: 'role documents',
      status: 'pass',
      reason: 'ok',
      detail: `no role documents under ${ROLES_DIR} (solo default is unaffected)`,
    });
  }
  return checks;
}

// Lane application: validate FIRST (so a contradictory role never touches
// the lane), then narrow via the resolver's own applyRoleToLane.
export async function applySelectedRole(
  lane: RoleLane,
  selected: SelectedRole,
  context: unknown,
): Promise<string[]> {
  validateResolvedRole(selected.resolved);
  validateRoleToolsRegistered(selected.resolved);
  return applyRoleToLane(lane, selected.resolved, context);
}

// Defense in depth (§40.3): the role's tools must be a subset of the tools
// the lane actually registers. resolveRole already refuses unknown names;
// this pins the same invariant at the lane boundary so a future tool-set
// edit cannot silently widen a role.
export function validateRoleToolsRegistered(resolved: ResolvedRole): void {
  const unknown = resolved.tools.find(
    (tool) => !(KNOWN_ROLE_TOOLS as readonly string[]).includes(tool),
  );
  if (unknown !== undefined) {
    throw new RoleRefusedError(
      resolved.name,
      `tool '${unknown}' is not registered on this lane`,
    );
  }
}

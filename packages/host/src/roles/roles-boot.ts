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
import type { EffectivePolicy } from '../policy/enterprise.js';
import {
  BUILTIN_PRESET_SOURCE,
  BUILTIN_ROLE_PRESETS,
} from './builtin-presets.js';
import type { RoleLayerInput } from './resolver.js';
import {
  applyRoleToLane,
  KNOWN_ROLE_TOOLS,
  type ParsedRoleDoc,
  parseRoleDocument,
  type ResolvedRole,
  type RoleLane,
  RoleParseError,
  RoleRefusedError,
  resolveRole,
  roleDoctorChecks,
  validateResolvedRole,
} from './resolver.js';

export const ROLES_DIR = '.kubic/roles';

/**
 * True when `error` is the filesystem saying `dir` is not there — ENOENT for a
 * missing path, ENOTDIR for a component that is a file. Any other failure
 * (EACCES, EIO, a corrupt document) is a real problem and must propagate, so
 * this deliberately checks the code and the path rather than catching broadly.
 */
function isAbsentDir(error: unknown, dir: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
  const path = (error as { path?: unknown }).path;
  // Some fs errors carry no path; the code alone is still unambiguous here
  // because this try block wraps exactly one directory read.
  return path === undefined || path === dir;
}

export class RoleBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleBootError';
  }
}

export interface RolesDirInput {
  // The bridge slice the loader actually uses (matches loadRoleDocuments'
  // own signature, issue #43). A full FileBridge satisfies it; tests drive
  // an in-memory fixture with the same two methods.
  bridge: Pick<FileBridge, 'listDir' | 'readTextFile'>;
  cwd: string;
  // Issue #229 (§35.1): the project root the repo documents resolve at —
  // the nearest ancestor holding `.kubic/` (or the git top level). Absent
  // means the cwd itself, so a `kubic run --role` from a subdirectory finds
  // the same `<root>/.kubic/roles/*.md` as one from the root.
  projectRoot?: string;
  // §58 enterprise policy (issue #288): when the effective policy gates
  // tools, a role declaring a denied tool is REFUSED at resolution — the same
  // check `kubic run --role` makes at boot (`resolveRole`'s grant gate). The
  // doctor probe reads it so a role the run would refuse is not shown green.
  // Absent means no enterprise tool policy is applied.
  toolPolicy?: EffectivePolicy;
  // §35.1 config `[roles.<name>]` layers (issue #133), merged under each
  // document exactly as `kubic run --role` merges them — so a role is judged
  // (contradictions, the enterprise tool gate) as it would actually run.
  // Absent means the documents alone.
  layers?: RoleLayerInput[];
}

// Where a role's winning document came from (issue #203): the preset bundled
// with the binary, or a document the workspace overrides it with.
export type RoleSource = 'builtin' | 'repo';

export interface LoadedRoles {
  docs: ParsedRoleDoc[];
  // The markdown behind each doc, keyed by role name — the repo file's text
  // when one won, the embedded preset's text otherwise. `rolePromptFor` reads
  // the `## Prompt` body from here, so an embedded role needs no file.
  texts: Record<string, string>;
  // The winning layer per role name (issue #203): `builtin` for an embedded
  // preset, `repo` for a `.kubic/roles/<name>.md` that overrode it.
  sources: Record<string, RoleSource>;
  resolved: ResolvedRole[];
  // Documents that parsed but were refused (§40.3) — reported, never
  // silently dropped: a contradictory role is exactly what doctor must
  // show. Keyed by role name.
  refused: Array<{ name: string; reason: string }>;
}

// The embedded presets are the lowest layer (issue #203): a workspace with no
// `.kubic/roles/` still gets the five §12 roles, and a repo document of the
// same name REPLACES the preset instead of joining it (one document per role,
// so a repo file can tighten or loosen its own role but not fork it). A
// document declaring a name no preset has joins the set as a new role.
function withBuiltins(
  repoDocs: Array<{ doc: ParsedRoleDoc; text: string }>,
): Pick<LoadedRoles, 'docs' | 'texts' | 'sources'> {
  const texts: Record<string, string> = {};
  const sources: Record<string, RoleSource> = {};
  const docs: ParsedRoleDoc[] = [];
  for (const [name, text] of Object.entries(BUILTIN_ROLE_PRESETS)) {
    texts[name] = text;
    sources[name] = BUILTIN_PRESET_SOURCE;
    docs.push(parseRoleDocument(text));
  }
  for (const { doc, text } of repoDocs) {
    texts[doc.name] = text;
    sources[doc.name] = 'repo';
    const at = docs.findIndex((entry) => entry.name === doc.name);
    if (at === -1) docs.push(doc);
    else docs[at] = doc;
  }
  return { docs, texts, sources };
}

// Every .md under .kubic/roles, parsed and resolved. A parse failure is
// named with the document's own path so a typo'd frontmatter cannot be
// mistaken for "no roles configured". A refusal (§40.3) is NOT fatal here
// — the set is reported so doctor can fail it; the lane boot is where a
// refused role stops a run.
export function loadRoles(input: RolesDirInput): LoadedRoles {
  const dir = `${input.projectRoot ?? input.cwd}/${ROLES_DIR}`;
  // Each entry is read and parsed as ITSELF — the text always comes from the
  // path that was listed, never re-derived from the parsed role name (a
  // document whose file stem differs from its `role:` line is legal: it
  // registers under the declared name). A parse failure is named with the
  // document's own path so a typo'd frontmatter cannot be mistaken for "no
  // roles configured".
  const repoDocs: Array<{ doc: ParsedRoleDoc; text: string }> = [];
  let entries: Array<{ name: string; path: string }>;
  try {
    entries = input.bridge
      .listDir(dir)
      .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({ name: entry.name, path: entry.path }));
  } catch (error) {
    // An absent `.kubic/roles/` is the NORMAL case, not a failure: most
    // workspaces have no role documents and the solo default is unaffected.
    // Letting the raw ENOENT escape made every `kubic doctor` red once the
    // probe was wired to the binary (measured). An unreadable directory that
    // DOES exist still throws — the distinction is between "nothing there"
    // and "there but broken", and only the former is silent.
    if (!isAbsentDir(error, dir)) throw error;
    entries = [];
  }
  for (const entry of entries) {
    let text: string;
    try {
      text = input.bridge.readTextFile(entry.path);
    } catch (error) {
      // A listed document that cannot be read is a real failure, and it is
      // named with its own path.
      throw new RoleBootError(
        `role document ${entry.path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      repoDocs.push({ doc: parseRoleDocument(text), text });
    } catch (error) {
      if (error instanceof RoleParseError) {
        throw new RoleBootError(
          `role document ${entry.path} is invalid: ${error.message}`,
        );
      }
      throw error;
    }
  }
  const { docs, texts, sources } = withBuiltins(repoDocs);
  const resolved: ResolvedRole[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const doc of docs) {
    try {
      resolved.push(
        resolveRole(doc, input.layers ?? [], {
          ...(input.toolPolicy === undefined
            ? {}
            : { toolPolicy: input.toolPolicy }),
        }),
      );
    } catch (error) {
      if (error instanceof RoleRefusedError) {
        refused.push({ name: doc.name, reason: error.message });
        continue;
      }
      throw error;
    }
  }
  return { docs, texts, sources, resolved, refused };
}

// The role a lane boot runs as. `--role` names it; an absent flag means no
// role (the solo default, unchanged). Fail-closed: an unknown role, a
// document that failed to parse, or a contradiction refuses the run with a
// named reason — never an invented fallback.
export interface RoleSelectionInput extends RolesDirInput {
  role: string;
  // §35.1/§58 layering: layer-supplied tool_policy/tools over the document.
  // Empty in the shipped binary (no config layer populates roles yet).
  // (`layers` and `toolPolicy` are inherited from RolesDirInput: the role is
  // resolved under the config layers, and its declared tools are checked
  // against the §58 enterprise policy — a denied tool refuses the role
  // instead of reaching the lane.)
}

export interface SelectedRole {
  resolved: ResolvedRole;
  doc: ParsedRoleDoc;
  // The winning document's markdown and its layer (issue #203) — callers read
  // the prompt from `markdown`, which works for an embedded preset too.
  markdown: string;
  source: RoleSource;
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
  const resolved = resolveRole(doc, input.layers ?? [], {
    ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
  });
  return {
    resolved,
    doc,
    markdown: loaded.texts[doc.name] ?? '',
    source: loaded.sources[doc.name] ?? BUILTIN_PRESET_SOURCE,
  };
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
  const checks = roleDoctorChecks(loaded.resolved, loaded.sources);
  for (const refusal of loaded.refused) {
    checks.push({
      id: `role:${refusal.name}`,
      label: `role ${refusal.name}`,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: refusal.reason,
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

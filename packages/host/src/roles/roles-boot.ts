// Role documents on the live path. The resolver owns parsing, layering and the
// agreement check; this module is the boot seam that actually calls it —
// loads `.kubic/roles/*.md` through the exec FileBridge, refuses a
// contradictory role by name, projects the loaded set onto doctor, and
// hands the resolved role's tool set + prompt text to a lane boot.
//
// I/O confinement: this module never imports node:fs. The bridge is
// injected, so tests drive fixtures while prod passes the real FileBridge.

import type { PermissionClasses } from '@kubic/agent/permissions';
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import type { FileBridge } from '@kubic/exec/file-bridge';
import type { DoctorCheck } from '../doctor/index.js';
import type { EffectivePolicy } from '../policy/index.js';
import {
  BUILTIN_PRESET_SOURCE,
  BUILTIN_ROLE_PRESETS,
} from './builtin-presets.js';
import type { RoleLayerInput } from './resolver.js';
import {
  type ResolvedRole,
  RoleRefusedError,
  resolveRole,
  roleDoctorChecks,
} from './resolver.js';
import type { ParsedRoleDoc } from './role-document.js';
import {
  parseRoleDocument,
  RESERVED_ROLE_REASON,
  RoleParseError,
} from './role-document.js';

const ROLES_DIR = '.kubic/roles';

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

/** @internal */
export class RoleBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleBootError';
  }
}

export interface RolesDirInput {
  // The bridge slice the loader actually uses (listDir and readTextFile). A
  // full FileBridge satisfies it; tests drive
  // an in-memory fixture with the same two methods.
  bridge: Pick<FileBridge, 'listDir' | 'readTextFile'>;
  cwd: string;
  // The project root the repo documents resolve at —
  // the nearest ancestor holding `.kubic/` (or the git top level). Absent
  // means the cwd itself, so a `kubic run --role` from a subdirectory finds
  // the same `<root>/.kubic/roles/*.md` as one from the root.
  projectRoot?: string;
  // The home directory whose `.kubic/roles/*.md` load as
  // a lower-precedence source below the project documents — personal roles
  // that apply in every repo. Absent means no global source (all existing
  // callers): the composition root passes the real home explicitly, tests
  // inject a fixture. Never trust-gated: only the repo documents
  // are withheld from untrusted roots.
  home?: string;
  // Project trust for the repo documents —
  // exactly like project skills. The check runs against the project root
  // (one path, not per ancestor). Absent both inputs means untrusted:
  // repo documents are withheld, builtins still load. `KUBIC_TRUST_PROJECT`
  // arrives through `trustProject` (the config load's per-path check folds
  // the env opt-in in), never as a separate flag here.
  trusted?: boolean;
  trustProject?: (dir: string) => boolean;
  // Enterprise policy: when the effective policy gates
  // tools, a role declaring a denied tool is REFUSED at resolution — the same
  // check `kubic run --role` makes at boot (`resolveRole`'s grant gate). The
  // doctor probe reads it so a role the run would refuse is not shown green.
  // Absent means no enterprise tool policy is applied.
  toolPolicy?: EffectivePolicy;
  // Config `[roles.<name>]` layers, merged under each
  // document exactly as `kubic run --role` merges them — so a role is judged
  // (contradictions, the enterprise tool gate) as it would actually run.
  // Absent means the documents alone.
  layers?: RoleLayerInput[];
  // The run's config classes — the probe's detail then
  // names the EFFECTIVE classes (most restrictive merge with each role's)
  // the lane would install. Absent keeps the role's own tool list.
  classes?: PermissionClasses;
}

// Where a role's winning document came from: the preset bundled
// with the binary, a `~/.kubic/roles/*.md` personal document,
// or a project document the workspace overrides both with.
type RoleSource = 'builtin' | 'global' | 'repo';

/** @internal */
export interface LoadedRoles {
  docs: ParsedRoleDoc[];
  // The markdown behind each doc, keyed by role name — the repo file's text
  // when one won, the embedded preset's text otherwise. `rolePromptFor` reads
  // the `## Prompt` body from here, so an embedded role needs no file.
  texts: Record<string, string>;
  // The winning layer per role name: `builtin` for an embedded
  // preset, `repo` for a `.kubic/roles/<name>.md` that overrode it.
  sources: Record<string, RoleSource>;
  resolved: ResolvedRole[];
  // Documents that parsed but were refused — reported, never
  // silently dropped: a contradictory role is exactly what doctor must
  // show. Keyed by role name.
  refused: Array<{ name: string; reason: string }>;
  // Documents that FAILED to parse — reported by file stem,
  // never thrown: one malformed document must not block every `--role`.
  // `selectRole` still refuses when the SELECTED name matches one of
  // these stems; doctor fails each one by name.
  invalid: Array<{ name: string; path: string; reason: string }>;
  // Declared names claimed by two or more documents of the
  // same layer — refused by name (doctor fail + selection refusal), all
  // files listed. No copy wins: a forked name resolves to nothing, not
  // even a same-named builtin or a unique copy in the other layer. A
  // single repo document overriding a builtin, or a repo
  // document over a unique global one, is not a duplicate
  // and still wins.
  duplicates: Array<{ name: string; paths: string[] }>;
  // Repo documents withheld by project trust —
  // named, never silently dropped: an untrusted root's roles are not
  // offered and `--role` naming one refuses with the trust message.
  // Empty when the root is trusted or holds no `.kubic/roles/`.
  withheld: Array<{ name: string; reason: string }>;
}

// The embedded presets are the lowest layer: a workspace with no
// `.kubic/roles/` still gets the five roles, and a repo document of the
// same name REPLACES the preset instead of joining it (one document per role,
// so a repo file can tighten or loosen its own role but not fork it). A
// document declaring a name no preset has joins the set as a new role.
// The lower layers arrive in precedence order (global personal
// documents first, project documents last) and each REPLACES the same-named
// winner below it — a project document wins over a global one, a global one
// over a preset, under exactly the same per-document rules.
function withBuiltins(
  lowerDocs: Array<{ doc: ParsedRoleDoc; text: string; source: RoleSource }>,
): Pick<LoadedRoles, 'docs' | 'texts' | 'sources'> {
  const texts: Record<string, string> = {};
  const sources: Record<string, RoleSource> = {};
  const docs: ParsedRoleDoc[] = [];
  for (const [name, text] of Object.entries(BUILTIN_ROLE_PRESETS)) {
    texts[name] = text;
    sources[name] = BUILTIN_PRESET_SOURCE;
    docs.push(parseRoleDocument(text));
  }
  for (const { doc, text, source } of lowerDocs) {
    texts[doc.name] = text;
    sources[doc.name] = source;
    const at = docs.findIndex((entry) => entry.name === doc.name);
    if (at === -1) docs.push(doc);
    else docs[at] = doc;
  }
  return { docs, texts, sources };
}

// The `.md` entries directly under one source directory, sorted by name —
// a document whose file stem differs from its `role:` line is legal (it
// registers under the declared name), so callers keep each entry's own
// path. An absent directory is the normal case (most workspaces configure
// no roles) and lists as empty; an unreadable directory that DOES exist
// still throws — the distinction is between "nothing there" and "there but
// broken", and only the former is silent.
function listSourceDir(
  bridge: Pick<FileBridge, 'listDir'>,
  dir: string,
): Array<{ name: string; path: string }> {
  try {
    return bridge
      .listDir(dir)
      .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({ name: entry.name, path: entry.path }));
  } catch (error) {
    if (!isAbsentDir(error, dir)) throw error;
    return [];
  }
}

// Every .md under .kubic/roles, parsed and resolved. A parse failure is
// named with the document's own path so a typo'd frontmatter cannot be
// mistaken for "no roles configured". A refusal is NOT fatal here
// — the set is reported so doctor can fail it; the lane boot is where a
// refused role stops a run.
/** @internal */
export function loadRoles(input: RolesDirInput): LoadedRoles {
  const root = input.projectRoot ?? input.cwd;
  const dir = `${root}/${ROLES_DIR}`;
  // The repo documents load only for a trusted
  // root — exactly like project skills. Builtins are unaffected.
  const repoTrusted =
    input.trustProject !== undefined
      ? input.trustProject(root)
      : (input.trusted ?? false);
  const withheld: Array<{ name: string; reason: string }> = [];
  // The global personal documents, read under the same
  // per-document rules as the repo ones — a listed document that cannot
  // be read throws named with its own path, a parse failure is recorded
  // in `invalid` — but never under the trust gate: only the repo
  // documents are withheld from untrusted roots. Loaded below, after the
  // shared `invalid` record exists.
  const globalDocs: Array<{
    doc: ParsedRoleDoc;
    text: string;
    path: string;
  }> = [];
  // Each entry is read and parsed as ITSELF — the text always comes from the
  // path that was listed, never re-derived from the parsed role name (a
  // document whose file stem differs from its `role:` line is legal: it
  // registers under the declared name). A parse failure is named with the
  // document's own path so a typo'd frontmatter cannot be mistaken for "no
  // roles configured".
  const repoDocs: Array<{ doc: ParsedRoleDoc; text: string; path: string }> =
    [];
  // A document that fails to parse is recorded here — with
  // the file stem, since the declared name is unknowable — instead of
  // aborting the whole load. Only the selected document can block
  // selection (see selectRole); the rest surface in doctor.
  const invalid: Array<{ name: string; path: string; reason: string }> = [];
  let entries: Array<{ name: string; path: string }>;
  // Load the global personal documents here — after
  // `invalid` exists, before the repo layer below. Never trust-gated.
  if (input.home !== undefined) {
    for (const entry of listSourceDir(
      input.bridge,
      `${input.home}/.kubic/roles`,
    )) {
      let text: string;
      try {
        text = input.bridge.readTextFile(entry.path);
      } catch (error) {
        throw new RoleBootError(
          `role document ${entry.path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        globalDocs.push({
          doc: parseRoleDocument(text),
          text,
          path: entry.path,
        });
      } catch (error) {
        if (error instanceof RoleParseError) {
          invalid.push({
            name: entry.name.slice(0, -'.md'.length),
            path: entry.path,
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
    }
  }
  if (!repoTrusted) {
    // Untrusted: name what is withheld (stems only — contents are never
    // read) so doctor and `--role` can say what trust would unlock. An
    // unlistable or absent dir withholds nothing by name (the trust
    // refusal in selectRole still applies to anything actually there).
    // Nothing is read below: entries stays empty.
    entries = [];
    try {
      for (const entry of input.bridge.listDir(dir)) {
        if (!entry.isDirectory && entry.name.endsWith('.md')) {
          const name = entry.name.slice(0, -'.md'.length);
          withheld.push({
            name,
            reason: `project role '${name}' withheld: untrusted project root ${root} (trust it with 'kubic trust' or set KUBIC_TRUST_PROJECT=1)`,
          });
        }
      }
      withheld.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      // Absent or unreadable dir: nothing to name.
    }
  } else {
    try {
      entries = input.bridge
        .listDir(dir)
        .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((entry) => ({ name: entry.name, path: entry.path }));
    } catch (error) {
      // An absent `.kubic/roles/` is the NORMAL case, not a failure: most
      // workspaces have no role documents and the default is unaffected.
      // Letting the raw ENOENT escape would make every `kubic doctor` red, since
      // the probe is wired to the binary. An unreadable directory that
      // DOES exist still throws — the distinction is between "nothing there"
      // and "there but broken", and only the former is silent.
      if (!isAbsentDir(error, dir)) throw error;
      entries = [];
    }
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
      repoDocs.push({ doc: parseRoleDocument(text), text, path: entry.path });
    } catch (error) {
      if (error instanceof RoleParseError) {
        invalid.push({
          name: entry.name.slice(0, -'.md'.length),
          path: entry.path,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  // Partition out repo-vs-repo duplicate declared names —
  // only uniquely-declared documents reach the builtin merge below.
  const byName = new Map<string, string[]>();
  for (const { doc, path } of repoDocs) {
    byName.set(doc.name, [...(byName.get(doc.name) ?? []), path]);
  }
  const duplicates: Array<{ name: string; paths: string[] }> = [];
  for (const [name, paths] of byName) {
    if (paths.length > 1) duplicates.push({ name, paths });
  }
  // The same partitioning for global-vs-global forks — a
  // global name claimed twice resolves to nothing, exactly like a repo
  // fork. A name claimed once globally and once (uniquely) in the repo
  // is NOT a fork: both layers pass the filter and the project document
  // wins by precedence in the merge below. A name forked in EITHER
  // layer poisons the name everywhere: an ambiguous project layer never
  // silently falls back to the global copy.
  const globalByName = new Map<string, string[]>();
  for (const { doc, path } of globalDocs) {
    globalByName.set(doc.name, [...(globalByName.get(doc.name) ?? []), path]);
  }
  for (const [name, paths] of globalByName) {
    if (paths.length > 1) duplicates.push({ name, paths });
  }
  duplicates.sort((a, b) => (a.name < b.name ? -1 : 1));
  const dupNames = new Set(duplicates.map((dup) => dup.name));
  const { docs, texts, sources } = withBuiltins([
    ...globalDocs
      .filter(({ doc }) => !dupNames.has(doc.name))
      .map((entry) => ({ ...entry, source: 'global' as const })),
    ...repoDocs
      .filter(({ doc }) => !dupNames.has(doc.name))
      .map((entry) => ({ ...entry, source: 'repo' as const })),
  ]);
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
  return {
    docs,
    texts,
    sources,
    resolved,
    refused,
    withheld,
    invalid,
    duplicates,
  };
}

// The role a lane boot runs as. `--role` names it; an absent flag means no
// role (the default, unchanged). Fail-closed: an unknown role, a
// document that failed to parse, or a contradiction refuses the run with a
// named reason — never an invented fallback.
export interface RoleSelectionInput extends RolesDirInput {
  role: string;
  // Layering: layer-supplied tool_policy/tools over the document.
  // Empty in the shipped binary (no config layer populates roles yet).
  // (`layers` and `toolPolicy` are inherited from RolesDirInput: the role is
  // resolved under the config layers, and its declared tools are checked
  // against the enterprise policy — a denied tool refuses the role
  // instead of reaching the lane.)
}

export interface SelectedRole {
  resolved: ResolvedRole;
  doc: ParsedRoleDoc;
  // The winning document's markdown and its layer — callers read
  // the prompt from `markdown`, which works for an embedded preset too.
  markdown: string;
  source: RoleSource;
}

// One wording for the forked-name refusal — doctor and
// selection refuse with the same named reason.
function duplicateRefusal(dup: { name: string; paths: string[] }): string {
  return `role '${dup.name}' is declared by ${dup.paths.length} documents (${dup.paths.join(', ')}): refusing an ambiguous role`;
}

export function selectRole(input: RoleSelectionInput): SelectedRole {
  if (input.role === DEFAULT_RUN_ROLE) {
    throw new RoleBootError(
      `${RESERVED_ROLE_REASON}; omit --role to run without one`,
    );
  }
  const loaded = loadRoles(input);
  // A forked name is refused before anything else — no copy
  // wins, not even a same-named builtin.
  const dup = loaded.duplicates.find((entry) => entry.name === input.role);
  if (dup !== undefined) {
    throw new RoleBootError(duplicateRefusal(dup));
  }
  // Selecting a document that failed to parse refuses with
  // that document's own parse error — checked before the builtin
  // fallback, so a malformed `planner.md` cannot silently run the
  // embedded planner preset. Nothing else can block selection.
  const bad = loaded.invalid.find((entry) => entry.name === input.role);
  if (bad !== undefined) {
    throw new RoleBootError(
      `role document ${bad.path} is invalid: ${bad.reason}`,
    );
  }
  const doc = loaded.docs.find((entry) => entry.name === input.role);
  if (doc === undefined) {
    // A name the untrusted root withholds refuses
    // with the trust message, not the unknown-role message — the user must
    // learn it is trust, not a typo, that blocks them.
    const held = loaded.withheld.find((entry) => entry.name === input.role);
    if (held !== undefined) throw new RoleBootError(held.reason);
    // A withheld document is never read, so its declared role may differ
    // from its file name: name the withheld files too, so a name that trust
    // would unlock does not read as a typo. The builtins always load, so
    // the loaded list is never empty.
    const known = loaded.docs.map((entry) => entry.name).join(', ');
    const withheldNames = loaded.withheld.map((entry) => entry.name).join(', ');
    throw new RoleBootError(
      `no role document for '${input.role}' under ${ROLES_DIR} (loaded: ${known}${withheldNames === '' ? '' : `; withheld by project trust: ${withheldNames}`})`,
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

// On the lane: the role's resolved tool set becomes the lane's
// allowlist (absence, not approval, withholds a tool) and the role's prompt
// text replaces the constant. Both halves are the resolver's own
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

// Doctor projection: one `role:<name>` check per resolved
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
  const checks = roleDoctorChecks(
    loaded.resolved,
    loaded.sources,
    input.classes,
  );
  for (const refusal of loaded.refused) {
    checks.push({
      id: `role:${refusal.name}`,
      label: `role ${refusal.name}`,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: refusal.reason,
    });
  }
  // Withheld project roles are a trust state,
  // not a breakage — warn (informational, never exit-flipping), never fail.
  for (const held of loaded.withheld) {
    checks.push({
      id: `role:${held.name}`,
      label: `role ${held.name}`,
      status: 'warn',
      reason: 'policy-mismatch',
      detail: held.reason,
    });
  }
  // Every document that failed to parse fails doctor by its
  // file stem, naming the file and the parse error.
  for (const bad of loaded.invalid) {
    checks.push({
      id: `role:${bad.name}`,
      label: `role ${bad.name}`,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: `role document ${bad.path} is invalid: ${bad.reason}`,
    });
  }
  // Every forked name fails doctor, listing every file that
  // declares it.
  for (const forked of loaded.duplicates) {
    checks.push({
      id: `role:${forked.name}`,
      label: `role ${forked.name}`,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: duplicateRefusal(forked),
    });
  }
  return checks;
}

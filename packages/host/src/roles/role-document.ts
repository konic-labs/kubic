// A role document (`.kubic/roles/<name>.md`): its front matter parsed into
// the role's name, tools, skills, approval requirements, model pin and
// permission classes. A malformed document is refused by name; parsing reads
// no file itself.

import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';

export class RoleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleParseError';
  }
}

// Why no role document or `--role` may use the name a run without --role
// records.
export const RESERVED_ROLE_REASON = `role name '${DEFAULT_RUN_ROLE}' is reserved for runs without --role`;

export interface RoleToolPolicy {
  filesystem?: unknown;
  shell?: unknown;
  network?: unknown;
  git?: unknown;
  credentials?: unknown;
}

export interface ParsedRoleDoc {
  name: string;
  // `description` is shown by doctor.
  description?: string;
  // The document's own `provider/id` model pin — the
  // lowest model tier (CLI > config `[roles.<r>]` > document).
  // Validated at parse, so a malformed ref is refused by name everywhere.
  model?: string;
  tools?: string[];
  // The skills this role sees, by skill name. Absent
  // means no restriction (every gated-visible skill is offered); a
  // declared list restricts the visible set to its names.
  skills?: string[];
  // Tool names that always require approval under
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

// Front matter contract: a `---`-delimited block of `key: value` (or
// `key = value`) lines. `role` names the role, `tools` is a `[a, b]`
// (or bare `a, b`) list, `skills` is a `[a, b]` list of the skill names
// this role sees (absent means unrestricted), `requires` is a
// `[a, b]` list of tool names that always require approval under this role
// (absent means none), and the five permission-class keys carry
// the tool_policy. Unknown keys are refused fail-closed, never ignored.
export function parseRoleDocument(markdown: string): ParsedRoleDoc {
  // Normalize Windows line endings (and strip a leading
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
      // Pi-agent alias of `role` — a second name for
      // the same document, refused when the two disagree.
      alias = String(parseScalar(raw));
    } else if (key === 'description') {
      description = String(parseScalar(raw));
    } else if (key === 'model') {
      modelRaw = String(parseScalar(raw));
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
  // A run without --role records the role `default`: a document of that
  // name could not be told apart from it in trajectory and audit records.
  if (name === DEFAULT_RUN_ROLE) {
    throw new RoleParseError(RESERVED_ROLE_REASON);
  }
  // The document model pin: `provider/id`, both sides
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
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(requires === undefined ? {} : { requires }),
    classes,
  };
}

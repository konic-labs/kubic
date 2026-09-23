// Prompt templates + role presets (issue #36; design §30). Templates are
// {name, description?, content} markdown files with an `args` frontmatter
// spec; role presets are templates with a `grants` frontmatter map, so a
// preset loads as template + capability grant in one file read.
//
// Callable from three surfaces sharing one renderer: the CLI surface
// (exit-code contract), the TUI surface (title/body view model, never
// throws), and the agent surface (rendered prompt string for prompt
// assembly). I/O confinement: reads go through the injected exec
// FileBridge; tests back it with FakeExecutionEnv.
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { type PermissionClasses, validateClasses } from '../policy.js';

export interface TemplateArg {
  name: string;
  required: boolean;
  default?: string;
  description?: string;
}

export interface PromptTemplate {
  name: string;
  description?: string;
  args: TemplateArg[];
  content: string;
  filePath: string;
}

export interface RolePreset {
  template: PromptTemplate;
  grants: PermissionClasses;
}

type Scalar = string | boolean;

function parseScalar(raw: string): Scalar {
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

// Split a flow sequence/map body on top-level commas (no nesting support —
// one level only, matching the template frontmatter contract).
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function parseFlowMap(raw: string): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const part of splitTopLevel(raw.slice(1, -1))) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    if (key !== '') out[key] = parseScalar(part.slice(colon + 1));
  }
  return out;
}

function parseFrontmatter(raw: string): {
  fields: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { fields: {}, body: raw };
  }
  const lines = raw.split('\n');
  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (closing <= 0) return { fields: {}, body: raw };
  const fields: Record<string, unknown> = {};
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === '') continue;
    const isFlowList = value.length > 1 && value[0] === '[';
    const tail = value.slice(-1);
    if (isFlowList && tail === ']') {
      fields[key] = splitTopLevel(value.slice(1, -1)).map((entry) => {
        const item = entry.trim();
        return item.startsWith('{') && item.endsWith('}')
          ? parseFlowMap(item)
          : parseScalar(item);
      });
    } else if (value.startsWith('{') && value.endsWith('}')) {
      fields[key] = parseFlowMap(value);
    } else {
      fields[key] = parseScalar(value);
    }
  }
  return { fields, body: lines.slice(closing + 1).join('\n') };
}

function basenameOf(path: string): string {
  const clean = path.replace(/\/*$/, '');
  const slash = clean.lastIndexOf('/');
  const base = slash === -1 ? clean : clean.slice(slash + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

function parseTemplateArgs(value: unknown, filePath: string): TemplateArg[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`template '${filePath}' has a non-list 'args' spec`);
  }
  return value.map((entry) => {
    const record: Record<string, unknown> =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : { name: entry };
    const name = record.name;
    if (typeof name !== 'string' || name === '') {
      throw new Error(`template '${filePath}' has an arg without a name`);
    }
    const arg: TemplateArg = {
      name,
      required: record.required === true,
    };
    if (typeof record.default === 'string') arg.default = record.default;
    if (typeof record.description === 'string') {
      arg.description = record.description;
    }
    return arg;
  });
}

export function parsePromptTemplate(
  filePath: string,
  raw: string,
): PromptTemplate {
  const { fields, body } = parseFrontmatter(raw);
  const name =
    typeof fields.name === 'string' && fields.name !== ''
      ? fields.name
      : basenameOf(filePath);
  const template: PromptTemplate = {
    name,
    args: parseTemplateArgs(fields.args, filePath),
    content: body,
    filePath,
  };
  if (typeof fields.description === 'string') {
    template.description = fields.description;
  }
  return template;
}

function joinPosix(...parts: string[]): string {
  const segments: string[] = [];
  for (const chunk of parts.join('/').split('/')) {
    if (chunk === '' || chunk === '.') continue;
    if (chunk === '..') {
      segments.pop();
      continue;
    }
    segments.push(chunk);
  }
  return `/${segments.join('/')}`;
}

export function discoverTemplates(
  bridge: FileBridge,
  dirs: string[],
  log?: (line: string) => void,
): PromptTemplate[] {
  const templates: PromptTemplate[] = [];
  for (const dir of dirs) {
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = bridge.listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries
      .filter((candidate) => candidate.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = joinPosix(dir, entry.name);
      let raw: string;
      try {
        raw = bridge.readTextFile(filePath);
      } catch {
        log?.(`template skipped (unreadable ${filePath})`);
        continue;
      }
      templates.push(parsePromptTemplate(filePath, raw));
    }
  }
  return templates;
}

export function renderPromptTemplate(
  template: PromptTemplate,
  args: Record<string, string>,
): string {
  const values: Record<string, string> = {};
  for (const spec of template.args) {
    const provided = args[spec.name];
    if (provided !== undefined) {
      values[spec.name] = provided;
    } else if (spec.default !== undefined) {
      values[spec.name] = spec.default;
    } else if (spec.required) {
      throw new Error(
        `template '${template.name}' needs argument '${spec.name}'`,
      );
    } else {
      values[spec.name] = '';
    }
  }
  return template.content.replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (match, name: string) => values[name] ?? match,
  );
}

// Pi-compatible invocation rendering (§30 formatPromptTemplateInvocation):
// the invoked template name plus its rendered body in one block.
export function formatPromptTemplateInvocation(
  template: PromptTemplate,
  args: Record<string, string>,
): string {
  const rendered = renderPromptTemplate(template, args);
  return `<prompt-template name="${template.name}">\n${rendered}\n</prompt-template>`;
}

export interface TemplateStore {
  templates: PromptTemplate[];
}

function findTemplate(store: TemplateStore, name: string): PromptTemplate {
  const hit = store.templates.find((template) => template.name === name);
  if (hit === undefined) throw new Error(`unknown template '${name}'`);
  return hit;
}

// CLI surface: exit-code contract, human-readable errors on `out`.
export function invokeTemplateCli(
  name: string,
  args: Record<string, string>,
  deps: TemplateStore & { out: (line: string) => void },
): number {
  try {
    deps.out(renderPromptTemplate(findTemplate(deps, name), args));
    return 0;
  } catch (error) {
    deps.out(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

// TUI surface: title/body view model for overlay rendering; never throws.
export interface TemplateView {
  title: string;
  body: string;
  error?: string;
}

export function invokeTemplateTui(
  name: string,
  args: Record<string, string>,
  deps: TemplateStore,
): TemplateView {
  try {
    const template = findTemplate(deps, name);
    return {
      title: template.name,
      body: renderPromptTemplate(template, args),
    };
  } catch (error) {
    return {
      title: name,
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Agent surface: rendered prompt string for prompt assembly; throws on
// unknown templates or missing args (caller reports, never mid-task-fails
// silently).
export function invokeTemplateAgent(
  name: string,
  args: Record<string, string>,
  deps: TemplateStore,
): string {
  return renderPromptTemplate(findTemplate(deps, name), args);
}

// Role presets are files: <presetsDir>/<name>.md with a `grants` partial
// permission map validated against the policy model (issue #15). Returns
// the template and the grant together — the preset is both.
export function loadRolePreset(
  bridge: FileBridge,
  presetsDir: string,
  name: string,
): RolePreset {
  const filePath = joinPosix(presetsDir, `${name}.md`);
  let raw: string;
  try {
    raw = bridge.readTextFile(filePath);
  } catch {
    throw new Error(`unknown role preset '${name}'`);
  }
  const { fields } = parseFrontmatter(raw);
  const grants = validateClasses(
    typeof fields.grants === 'object' && fields.grants !== null
      ? (fields.grants as Record<string, unknown>)
      : {},
  );
  return { template: parsePromptTemplate(filePath, raw), grants };
}

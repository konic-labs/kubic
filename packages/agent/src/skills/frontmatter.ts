// Parsing a SKILL.md: the frontmatter subset the contract needs, and the
// body.
import { basenameOf, dirnameOf } from './paths.js';
import type { LoadedSkill } from './types.js';

type FrontmatterValue = string | boolean | string[];

function stripScalarQuotes(item: string): string {
  const trimmed = item.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFlowList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((entry) => stripScalarQuotes(entry));
}

function parseFrontmatterValue(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) return parseFlowList(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// Is this frontmatter line a continuation of the block opened
// at keyIndent — a blank line, or anything indented past the key?
function isBlockContinuation(line: string, keyIndent: number): boolean {
  if (line.trim() === '') return true;
  const indent = line.search(/\S/);
  return indent !== -1 && indent > keyIndent;
}

// A `- item` block sequence under an empty-valued key.
// Returns undefined when the continuation holds no list items, so plain
// indented text still reads as an empty value (fail-open, as before).
function collectBlockSequence(
  fmLines: string[],
  from: number,
  keyIndent: number,
): { items: string[] | undefined; next: number } {
  const items: string[] = [];
  let sawItem = false;
  let next = from;
  for (let j = from; j < fmLines.length; j++) {
    const candidate = fmLines[j];
    if (candidate === undefined || !isBlockContinuation(candidate, keyIndent)) {
      break;
    }
    next = j;
    const text = candidate.trim();
    if (text === '' || text.startsWith('#')) continue;
    if (!text.startsWith('-')) return { items: undefined, next: from };
    const item = stripScalarQuotes(text.slice(1));
    if (item !== '') {
      items.push(item);
      sawItem = true;
    }
  }
  if (!sawItem) return { items: undefined, next: from };
  return { items, next };
}

// A `>` folded or `|` literal block scalar. Chomping is clip
// by default (one trailing newline, then clipped), `-` strips and `+`
// keeps; blank lines separate folded paragraphs and are kept in literals.
function collectBlockScalar(
  fmLines: string[],
  from: number,
  keyIndent: number,
  folded: boolean,
  chomping: string | undefined,
): { text: string; next: number } {
  const taken: string[] = [];
  let next = from;
  for (let j = from; j < fmLines.length; j++) {
    const candidate = fmLines[j];
    if (candidate === undefined || !isBlockContinuation(candidate, keyIndent)) {
      break;
    }
    next = j;
    taken.push(candidate.trim());
  }
  while (taken.length > 0 && taken[taken.length - 1] === '') taken.pop();
  let text: string;
  if (folded) {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of taken) {
      if (line === '') {
        if (current.length > 0) paragraphs.push(current.join(' '));
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) paragraphs.push(current.join(' '));
    text = paragraphs.join('\n');
  } else {
    text = taken.join('\n');
  }
  if (chomping === '-') return { text, next };
  // `+` keeps a trailing newline; clip (the default) drops it. Trailing
  // blank runs beyond one newline are not reconstructed — the contract
  // keys never depend on them.
  if (chomping === '+') return { text: `${text}\n`, next };
  return { text, next };
}

export function parseSkillFile(
  filePath: string,
  raw: string,
): Omit<LoadedSkill, 'source'> {
  const frontmatter: Record<string, FrontmatterValue> = {};
  let body = raw;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const lines = raw.split('\n');
    const closing = lines.findIndex(
      (line, index) => index > 0 && line.trim() === '---',
    );
    if (closing > 0) {
      // The contract keys accept YAML block
      // sequences and folded/literal scalars — not just flow values.
      // Only the contract subset is supported (no anchors, tags, nested
      // maps, or indent indicators); anything else reads as a plain value.
      const fmLines = lines
        .slice(1, closing)
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
      for (let i = 0; i < fmLines.length; i++) {
        const line = fmLines[i];
        if (line === undefined) continue;
        if (line.trim() === '' || line.trim().startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        if (key === '') continue;
        const keyIndent = line.search(/\S/);
        const marker = line.slice(colon + 1).trim();
        const blockMatch = /^[>|]([+-])?$/.exec(marker);
        if (blockMatch !== null) {
          const { text, next } = collectBlockScalar(
            fmLines,
            i + 1,
            keyIndent,
            marker.startsWith('>'),
            blockMatch[1],
          );
          frontmatter[key] = text;
          i = next;
          continue;
        }
        if (marker === '') {
          const { items, next } = collectBlockSequence(
            fmLines,
            i + 1,
            keyIndent,
          );
          if (items !== undefined) {
            frontmatter[key] = items;
            i = next;
          }
          continue;
        }
        frontmatter[key] = parseFrontmatterValue(line.slice(colon + 1));
      }
      body = lines.slice(closing + 1).join('\n');
    }
  }
  const dirName = basenameOf(dirnameOf(filePath));
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name !== ''
      ? frontmatter.name
      : dirName;
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description
      : (firstLine ?? '');
  const roles =
    Array.isArray(frontmatter.roles) && frontmatter.roles.length > 0
      ? [...frontmatter.roles]
      : undefined;
  const requiredTools =
    Array.isArray(frontmatter.tools) && frontmatter.tools.length > 0
      ? [...frontmatter.tools]
      : undefined;
  return {
    name,
    description,
    filePath,
    roles,
    requiredTools,
    // The canonical kebab-case key hides
    // the skill; the camelCase spelling stays as an alias.
    disableModelInvocation:
      frontmatter['disable-model-invocation'] === true ||
      frontmatter.disableModelInvocation === true
        ? true
        : undefined,
    content: body,
  };
}

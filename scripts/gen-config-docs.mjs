// Generate the config docs from the config schema
// (packages/host/src/config/schema.ts): the key reference and the section list
// in docs/cli/configuration.md, and the example config
// packages/host/src/config/example.toml.
//
// Usage: node scripts/gen-config-docs.mjs [--check]
//   --check  write nothing; exit 1 naming each file that is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SECTIONS, EXAMPLE_HEADER } from '@kubic/host/config/schema';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'docs/cli/configuration.md';
const EXAMPLE = 'packages/host/src/config/example.toml';
const SCHEMA = 'packages/host/src/config/schema.ts';

// The docs' key reference: one subsection per docs row of each section, in
// order, headed by its keys (or its label).
export function renderKeyReference(sections) {
  return sections
    .flatMap((section) =>
      section.docs.map((row) => {
        const label =
          row.label ?? row.keys.map((key) => `\`${key}\``).join(', ');
        return `### ${label}\n\n${row.text}`;
      }),
    )
    .join('\n\n');
}

// The docs' section list: each section with its keys.
export function renderSectionList(sections) {
  return sections
    .map((section) => {
      const keys = section.keys
        .map(
          (key) =>
            `\`${key.name}\`${key.required === true ? ' (required)' : ''}`,
        )
        .join(', ');
      switch (section.shape) {
        case 'table':
          return `- \`[${section.name}]\`: ${keys}`;
        case 'tables':
          return `- \`[${section.name}.<name>]\`, one table per name: ${keys}`;
        case 'array':
          return `- \`[[${section.name}]]\`, an array of tables: ${keys}`;
        default:
          return `- \`${section.name}\`: a top-level key, not a section`;
      }
    })
    .join('\n');
}

// The example config: the header, the top-level keys (TOML puts them before
// any table), then each section's example values.
export function renderExample(sections, header) {
  const lines = header.map((line) => `# ${line}`);
  const keyLines = (key) => [
    ...(key.note ?? []).map((line) => `# ${line}`),
    `${key.name} = ${key.example}`,
  ];
  const blocks = [];
  for (const section of sections.filter((s) => s.shape === 'value')) {
    blocks.push(section.keys.filter((key) => key.example).flatMap(keyLines));
  }
  for (const section of sections.filter((s) => s.shape !== 'value')) {
    if (section.shape === 'table') {
      const body = section.keys
        .filter((key) => key.example !== undefined)
        .flatMap(keyLines);
      if (body.length > 0) blocks.push([`[${section.name}]`, ...body]);
      continue;
    }
    for (const [name, body] of Object.entries(section.exampleTables ?? {})) {
      blocks.push([
        section.shape === 'array'
          ? `[[${section.name}]]`
          : `[${section.name}.${name}]`,
        ...body,
      ]);
    }
  }
  return `${[lines, ...blocks].map((block) => block.join('\n')).join('\n\n')}\n`;
}

// The text between a generated block's markers, replaced.
export function replaceBetween(text, name, body) {
  const begin = `<!-- generated:${name} -->`;
  const end = `<!-- /generated:${name} -->`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`no '${name}' markers to generate into`);
  }
  return `${text.slice(0, from + begin.length)}\n${body}\n${text.slice(to)}`;
}

// Every generated file, with the content the schema says it should have.
export function generate(read) {
  const sections = CONFIG_SECTIONS;
  const docs = replaceBetween(
    replaceBetween(read(DOCS), 'config-keys', renderKeyReference(sections)),
    'config-sections',
    renderSectionList(sections),
  );
  return {
    [DOCS]: docs,
    [EXAMPLE]: renderExample(sections, EXAMPLE_HEADER),
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  const files = generate(read);
  const stale = Object.entries(files).filter(
    ([path, content]) => read(path) !== content,
  );
  if (check) {
    for (const [path] of stale) {
      console.error(
        `${path} is stale: run node scripts/gen-config-docs.mjs to regenerate it from ${SCHEMA}`,
      );
    }
    process.exit(stale.length === 0 ? 0 : 1);
  }
  for (const [path, content] of stale) writeFileSync(join(ROOT, path), content);
  console.log(
    stale.length === 0
      ? 'config docs are current'
      : `regenerated ${stale.map(([path]) => path).join(', ')}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

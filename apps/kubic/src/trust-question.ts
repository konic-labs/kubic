// The project-trust question, restyled:
// one row in the first screen's language — `◆ trust  <path> found — load
// project config?` — the full disclosure under it (what a grant lets the
// project's files do, the key risk included), and one key to answer:
// `y` yes, `n` not now, `v` view the file. The question still runs before
// the config load and the alt-screen (the layer must be decided before the
// lane boots); config/load.ts owns what each answer records.

import type { CliTheme } from '@kubic/core/cli/theme';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { TrustQuestion } from './config/load.js';

const LABEL = 12;
// Under the value column: `  ◆ trust       ` is 17 cells.
const HANGING = ' '.repeat(2 + 2 + LABEL + 1);

// What a grant lets the project's files do — the same facts as the
// one-line `confirm` question, the key risk included.
const DISCLOSURE =
  "This lets the project's own files take effect for runs here: its config.toml sets the model, approvals, permissions and journal retention, and its [verify] commands run as shell commands after each run; its models.json names provider URLs that are sent the key of any *_API_KEY or KUBIC_* variable it names (KUBIC_API_KEY by default); its project skills, role documents and [agent] systemPromptFile are instructions the model follows.";

/** The keys the question takes. */
export const TRUST_KEYS = [
  { key: 'y', label: 'yes', value: 'yes' },
  { key: 'n', label: 'not now', value: 'not-now' },
  { key: 'v', label: 'view file', value: 'view' },
] as const;

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u)) {
    if (word === '') continue;
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function tilde(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path;
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

export function trustQuestionLines(
  theme: CliTheme,
  question: TrustQuestion,
  width: number,
  home?: string,
): string[] {
  const ui = theme.ui;
  const room = Math.max(30, Math.floor(width) - HANGING.length - 1);
  const keys = TRUST_KEYS.map(
    ({ key, label }) =>
      `${ui.style({ fg: 'fg0', bold: true })(key)}  ${ui.fg('fg2')(label)}`,
  ).join('   ');
  return [
    `  ${ui.fg('warn')('◆')} ${ui.fg('fg1')('trust'.padEnd(LABEL))} ${ui.fg('fg0')(`${tilde(question.configPath, home)} found — load project config?`)}`,
    ...wrapWords(DISCLOSURE, room).map(
      (line) => `${HANGING}${ui.fg('fg2')(line)}`,
    ),
    `${HANGING}${keys}`,
  ];
}

/** Files past this size are not shown in full. */
const TRUST_VIEW_MAX_BYTES = 64 * 1024;
/** @internal */
export const TRUST_VIEW_MAX_LINES = 40;

// biome-ignore lint/suspicious/noControlCharactersInRegex: a repository's file never drives the terminal
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** `v`: the project config, as lines for the terminal (never its escapes). */
export function trustFileLines(theme: CliTheme, path: string): string[] {
  const ui = theme.ui;
  const files = createNodeFileBridge('/');
  let text: string;
  try {
    const info = files.fileInfo(path);
    if (info.isFile === false)
      return [`${HANGING}${ui.fg('err')('not a regular file')}`];
    if (info.size > TRUST_VIEW_MAX_BYTES) {
      return [
        `${HANGING}${ui.fg('warn')(`too large to show (${Math.round(info.size / 1024)} KB) — open it in an editor`)}`,
      ];
    }
    text = files.readTextFile(path);
  } catch (error) {
    return [
      `${HANGING}${ui.fg('err')(`cannot read it: ${error instanceof Error ? error.message : String(error)}`)}`,
    ];
  }
  const lines = text.replace(CONTROL, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const shown = lines.slice(0, TRUST_VIEW_MAX_LINES);
  return [
    '',
    ...shown.map((line) => `${HANGING}${ui.fg('fg3')('│')} ${line}`),
    ...(lines.length > shown.length
      ? [
          `${HANGING}${ui.fg('fg2')(`… ${lines.length - shown.length} more lines`)}`,
        ]
      : []),
    '',
  ];
}

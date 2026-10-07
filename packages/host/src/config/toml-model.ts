// Write the `[model]` table of a config.toml without disturbing anything else
// (`kubic setup`). A TOML round trip would drop comments and
// reorder keys, so this is a line-based update: inside an existing `[model]`
// table the `provider`, `id` and `thinking` lines are replaced in place (the
// missing ones are added at the end of the table); without one, the table is
// appended. Line endings (LF or CRLF) and every other line are preserved.

export interface ModelTableValues {
  readonly provider: string;
  readonly id: string;
  readonly thinking?: string;
}

const TABLE_HEADER = /^\s*\[\s*model\s*\]\s*(#.*)?$/u;
const ANY_HEADER = /^\s*\[/u;

function keyOf(line: string): string | undefined {
  return /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/u.exec(line)?.[1];
}

// TOML basic strings share JSON's escapes for the characters a model id can
// carry, so JSON.stringify is a valid TOML string literal here.
function entry(key: string, value: string): string {
  return `${key} = ${JSON.stringify(value)}`;
}

export function upsertModelTable(
  text: string,
  values: ModelTableValues,
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const wanted: [string, string][] = [
    ['provider', values.provider],
    ['id', values.id],
  ];
  if (values.thinking !== undefined) wanted.push(['thinking', values.thinking]);
  const lines = text === '' ? [] : text.split(/\r?\n/u);
  // A trailing newline leaves one empty last element; keep it aside.
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  const start = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (start === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1]?.trim() !== '') out.push('');
    out.push('[model]', ...wanted.map(([key, value]) => entry(key, value)));
    return `${out.join(eol)}${eol}`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (ANY_HEADER.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  const seen = new Set<string>();
  const body = lines.slice(start + 1, end).map((line) => {
    const key = keyOf(line);
    const value = wanted.find(([name]) => name === key);
    if (key === undefined || value === undefined) return line;
    seen.add(key);
    const indent = /^\s*/u.exec(line)?.[0] ?? '';
    return `${indent}${entry(value[0], value[1])}`;
  });
  // New keys go after the table's last non-blank line.
  let insertAt = body.length;
  while (insertAt > 0 && body[insertAt - 1]?.trim() === '') insertAt -= 1;
  const missing = wanted
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => entry(key, value));
  body.splice(insertAt, 0, ...missing);
  const out = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)];
  return `${out.join(eol)}${trailingNewline || out.length > 0 ? eol : ''}`;
}

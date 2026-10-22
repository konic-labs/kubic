// One CSV field for a report a spreadsheet will open: quoted when it must be
// (RFC 4180), and a value a spreadsheet would run as a formula — a leading
// `=`, `@`, tab or carriage return, or a `+`/`-` that is not a number —
// defused with a leading `'`, so the cell shows the value instead.
export function csvField(value: string): string {
  const formula =
    /^[=@\t\r]/.test(value) ||
    (/^[+-]/.test(value) && value.length > 1 && Number.isNaN(Number(value)));
  const safe = formula ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

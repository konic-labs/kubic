// Capture channels for a command's stdout and stderr lines.

// stdout (`lines`) and stderr (`errs`) captured separately.
export function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: (line: string): void => {
      lines.push(line);
    },
    err: (line: string): void => {
      errs.push(line);
    },
  };
}

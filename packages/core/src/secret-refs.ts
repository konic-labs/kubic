// Secret-reference forms: `$ENV_VAR`,
// `!command args` (no TTL — always re-run), `\$escaped` / `\!escaped`
// literals, anything else literal. Lives in @kubic/core so the AGENT's
// models.json parser and the HOST's request-time resolver share the one
// table (same direction as secret-shapes.ts): an agent → host
// import would break `npm run lint:deps`. Pure string parsing — no env,
// no processes, no audit; resolution stays in host/config/secrets.ts.

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRefError';
  }
}

export type SecretRef =
  | { kind: 'env'; name: string; raw: string }
  | { kind: 'command'; argv: string[]; raw: string }
  | { kind: 'literal'; value: string };

const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

// Shell-ish argv split for `!command`: single- and
// double-quoted spans stay one element, a backslash quotes the next
// character anywhere. No expansion, no globbing — the runner receives
// argv verbatim (execFile, never a shell). An unterminated boundary quote
// runs to the end rather than throwing. A quote OPENS quoting only at a
// word boundary: a mid-word quote is far more
// likely an apostrophe (`don't`) than grouping, so it stays literal and
// the helper receives exactly what was written. A close always closes.
export function splitSecretCommand(input: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let started = false;
  const push = (): void => {
    if (started) argv.push(current);
    current = '';
    started = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (char === '\\' && index + 1 < input.length) {
      current += input[index + 1] as string;
      started = true;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      // Word-boundary only: mid-word quotes are
      // literal apostrophes, not grouping — fall through and keep them.
      if (current === '') {
        quote = char;
        started = true;
        continue;
      }
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      push();
      continue;
    }
    current += char;
    started = true;
  }
  push();
  return argv;
}

// models.json secret forms: $ENV_VAR, !command args (no TTL — always
// re-run), \$escaped / \!escaped literals, anything else literal.
export function parseSecretRef(raw: unknown): SecretRef {
  if (typeof raw !== 'string') {
    throw new SecretRefError(
      `secret ref must be a string (got ${raw === null ? 'null' : typeof raw})`,
    );
  }
  if (raw.startsWith('\\') && (raw[1] === '$' || raw[1] === '!')) {
    return { kind: 'literal', value: raw.slice(1) };
  }
  const env = ENV_REF.exec(raw);
  if (env) return { kind: 'env', name: env[1] as string, raw };
  if (raw.startsWith('!')) {
    const argv = splitSecretCommand(raw.slice(1).trim());
    if (argv.length === 0)
      throw new SecretRefError('empty !command secret ref');
    return { kind: 'command', argv, raw };
  }
  return { kind: 'literal', value: raw };
}

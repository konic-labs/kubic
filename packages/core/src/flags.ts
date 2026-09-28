// Shared argv flag parser (issue #127; §78, issue #100's sibling).
//
// Every command used to hand-roll the same rule — "a value token starting
// with `--` means the flag is missing its value" — which made legitimate
// values unpassable (`kubic run -p "--help"`), knew no `--flag=value`
// form, and had no end-of-flags escape. One parser, one rule set:
//
//   1. `--` ends flag parsing: every later token is positional, verbatim.
//   2. `--name=value` takes the value verbatim (it may start with `--`,
//      and it may be empty). The equals form exists for value flags only
//      and works through aliases too (`-p=--help`).
//   3. `--name` / `-alias`: boolean flags become `true`; value flags
//      consume the next token only when it does not start with `--`.
//      Otherwise the flag is recorded in `missing` (canonical name) and
//      the token is parsed normally — the typo `kubic run -p --json` is
//      still caught, while `--prompt=--json` and `-p -- --json` are the
//      escape hatches. Callers map `missing` to their existing
//      "error: <flag> needs a value" lines and usage exits.
//   4. repeatable value flags collect arrays in insertion order; a
//      non-repeatable value flag takes its last occurrence.
//   5. A `--`-prefixed token matching no spec entry is collected in
//      `unknown` (verbatim, in order); callers keep their own strictness
//      (some refuse by name, some ignore). Single-dash tokens that match
//      no alias are positional — only `--`-prefixed tokens are flag
//      candidates, plus the aliases a spec declares.
//
// The parser does syntax; the command keeps its semantics (positive-int
// checks, id patterns, mutual exclusions, exit codes).
//
// Lives in core because host, eval, and the composition root all own
// command handlers and core is the only package all may import (dep-lint).
// Imports nothing, holds no state.

export interface FlagSpec {
  readonly name: string; // canonical long form, e.g. '--prompt'
  readonly takes: 'value' | 'boolean';
  readonly repeat?: boolean; // value flags only: collect a string[]
  readonly aliases?: readonly string[]; // '-p' → '--prompt'
}

export interface ParsedFlags {
  readonly values: Readonly<
    Record<string, string | string[] | boolean | undefined>
  >;
  readonly positional: readonly string[];
  // Non-empty ⇒ the caller prints its own "unknown flag" line + usage exit.
  readonly unknown: readonly string[];
  // Value flags seen without a value (canonical names, encounter order).
  readonly missing: readonly string[];
  // Token index in `args` of each `missing` entry (same order, same
  // length). Callers that need flag-ness — not argv token text — read
  // this: a token that merely reads `-p` may have been consumed as some
  // other value flag's VALUE, which is not a flag occurrence at all.
  readonly missingAt: readonly number[];
}

const TERMINATOR = '--';

// Any leading-dash token may name a spec entry (long form or alias); only
// `--`-prefixed tokens are flag candidates for the strict `unknown` list —
// a stray `-x` stays positional, as it does today.
function isDashToken(token: string): boolean {
  return token.startsWith('-');
}

/**
 * @deprecated Legacy hand-rolled parser, kept only for the command handlers
 * still reached through the pass-through forwarders in apps/kubic/src/
 * commands/. commander is the single parser (docs/contributing-cli.md):
 * a migrated command declares its options on its commander command and
 * stops calling this. Delete this module once no handler imports it.
 */
export function parseFlagArgs(
  args: readonly string[],
  spec: readonly FlagSpec[],
): ParsedFlags {
  const byToken = new Map<string, { spec: FlagSpec; canonical: string }>();
  for (const entry of spec) {
    byToken.set(entry.name, { spec: entry, canonical: entry.name });
    for (const alias of entry.aliases ?? []) {
      byToken.set(alias, { spec: entry, canonical: entry.name });
    }
  }
  const values: Record<string, string | string[] | boolean | undefined> = {};
  const positional: string[] = [];
  const unknown: string[] = [];
  const missing: string[] = [];
  const missingAt: number[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (token === TERMINATOR) {
      for (i += 1; i < args.length; i += 1) positional.push(args[i] as string);
      break;
    }
    const eq = isDashToken(token) ? token.indexOf('=') : -1;
    const head = eq === -1 ? token : token.slice(0, eq);
    const match = isDashToken(token) ? byToken.get(head) : undefined;
    if (match === undefined) {
      if (token.startsWith(TERMINATOR)) unknown.push(token);
      else positional.push(token);
      i += 1;
      continue;
    }
    const { spec: entry, canonical } = match;
    if (entry.takes === 'boolean') {
      // The equals form is a value-flag affordance: `--json=1` is not a
      // recognized spelling, so it stays strictly unknown.
      if (eq !== -1) {
        unknown.push(token);
        i += 1;
        continue;
      }
      values[canonical] = true;
      i += 1;
      continue;
    }
    if (eq !== -1) {
      assignValue(values, entry, canonical, token.slice(eq + 1));
      i += 1;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith(TERMINATOR)) {
      missing.push(canonical);
      missingAt.push(i);
      i += 1;
      continue;
    }
    assignValue(values, entry, canonical, next);
    i += 2;
  }
  return { values, positional, unknown, missing, missingAt };
}

function assignValue(
  values: Record<string, string | string[] | boolean | undefined>,
  spec: FlagSpec,
  canonical: string,
  value: string,
): void {
  if (spec.repeat === true) {
    const current = values[canonical];
    const list = Array.isArray(current) ? current : [];
    list.push(value);
    values[canonical] = list;
    return;
  }
  values[canonical] = value;
}

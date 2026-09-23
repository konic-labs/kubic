// CI grep-gate: no string may claim solo isolation, solo containment,
// or injection prevention (issue #58; §59.1). Claim patterns are
// verb/subject-anchored so honest senses keep passing: tracing span
// isolation, unicode isolates, "not a sandbox" guardrails, Phase-4 MCP
// containment requirements, and negated disclosures ("no isolation").
// Non-test sources under packages/*/src and apps/*/src are scanned;
// violation SAMPLES live in this *.test.ts file, which the scan skips.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ClaimRule {
  label: string;
  pattern: RegExp;
}

const CLAIM_RULES: ClaimRule[] = [
  {
    label: 'solo isolation/containment claim',
    pattern: /\bsolo\b[^.\n]{0,120}\b(isolat\w+|sandbox\w*|contain\w+)\b/i,
  },
  {
    label: 'isolation guarantee claim',
    pattern:
      /\b(provides?|ensures?|guarantees?|enforces?|offers?)\b[^.\n]{0,80}\b(isolation|sandbox|containment)\b/i,
  },
  {
    label: 'injection-prevention claim',
    pattern:
      /\binjection[-\s]?prevention\b|\bprevent\w*\b[^.\n]{0,80}injection\b|\bprotect\w*\b[^.\n]{0,40}\bfrom\b[^.\n]{0,40}injection\b/i,
  },
  {
    label: 'journal-as-backup claim',
    pattern: /\bjournal\b[^.\n]{0,80}\b(backups?|back\s?ups?)\b/i,
  },
];

// A negated disclosure is honest ("no isolation", "refused", Phase-4
// "unsupported") — only unnegated claims fail the gate.
const NEGATION =
  /\b(no|not|never|without|honest|refuse[sd]?|unsupported|warning|warns?|misconfigur\w+|guardrail)\b|\b\w+n't\b/i;

export function findClaimViolations(line: string): string[] {
  return CLAIM_RULES.filter(
    (rule) => rule.pattern.test(line) && !NEGATION.test(line),
  ).map((rule) => rule.label);
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(full);
      } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  for (const scope of ['packages', 'apps']) {
    const scopeDir = join(root, scope);
    for (const owner of readdirSync(scopeDir)) {
      const src = join(scopeDir, owner, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // No src dir (e.g. a package without one) — nothing to scan.
      }
    }
  }
  return out;
}

describe('honest-claims grep-gate (issue #58)', () => {
  it('flags solo isolation claims', () => {
    expect(
      findClaimViolations('solo runs in an isolated sandbox for safety'),
    ).not.toEqual([]);
  });

  it('flags isolation guarantee verbs', () => {
    expect(
      findClaimViolations('this layer provides isolation for agent runs'),
    ).not.toEqual([]);
  });

  it('flags injection-prevention claims', () => {
    expect(
      findClaimViolations('we prevent prompt injection attacks'),
    ).not.toEqual([]);
  });

  it('flags journal-as-backup claims', () => {
    expect(
      findClaimViolations('the journal is a full backup of state'),
    ).not.toEqual([]);
  });

  it('allows negated disclosures and unrelated senses', () => {
    const honest = [
      'Solo has no isolation (§3.7): confinement here is a cwd guardrail',
      'with the kubic.worker.startup span isolated from tool ms',
      'approval requires justification (§63): visible justification must contain at least 8',
      'spawn MCP servers under containment (Phase-4 epic)',
      'warning: solo mode has no isolation: this run executes in-process with your user authority.',
      'the change journal is a review/undo log, not a backup',
      'ExecutionEnv (sandboxed shell + filesystem for worker runs)',
      'Per-role injection: a worker receives ONLY its role credentials',
    ];
    for (const line of honest) {
      expect(findClaimViolations(line)).toEqual([]);
    }
  });

  it('no source file claims solo isolation/containment/injection-prevention', () => {
    // Vitest runs from the repo root, so the scan anchors at cwd.
    const root = process.cwd();
    const failures: string[] = [];
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const label of findClaimViolations(line)) {
          failures.push(`${file}:${index + 1} [${label}] ${line.trim()}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });
});

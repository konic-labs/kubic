// CI grep-gate: no string may claim solo isolation, solo containment,
// or injection prevention (issue #58; §59.1). Claim patterns are
// verb/subject-anchored so honest senses keep passing: tracing span
// isolation, unicode isolates, "not a sandbox" guardrails, Phase-4 MCP
// containment requirements, and negated disclosures ("no isolation").
// Negation is proximity-aware: it must precede the claimed noun within
// a token window, so trailing contrasts still fail. Every non-test
// source plus markdown docs are scanned; violation SAMPLES live in
// this *.test.ts file, which the scan skips.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ClaimRule {
  label: string;
  pattern: RegExp;
  // The noun this rule protects: a negation only excuses the line when
  // it precedes THIS noun, so an unrelated negated noun elsewhere on
  // the line cannot launder a real claim.
  noun: RegExp;
}

const CLAIM_RULES: ClaimRule[] = [
  {
    label: 'solo isolation/containment claim',
    pattern: /\bsolo\b[^.\n]{0,120}\b(isolat\w+|sandbox\w*|contain\w+)\b/i,
    noun: /isolat|sandbox|contain/,
  },
  {
    label: 'isolation guarantee claim',
    pattern:
      /\b(provides?|ensures?|guarantees?|enforces?|offers?|blocks?|blocked|blocking|isolat(e|es|ed|ing)|sandbox(ed|es|ing)?|stops?|stopped|stopping|mitigat\w+)\b[^.\n]{0,80}\b(isolat\w+|sandbox\w*|contain\w+)\b/i,
    noun: /isolat|sandbox|contain/,
  },
  {
    label: 'injection-prevention claim',
    pattern:
      /\binjection[-\s]?prevention\b|\b(prevent\w*|protect\w*|blocks?|blocked|blocking|stops?|stopped|stopping|mitigat\w+)\b[^.\n]{0,80}\binjection\b|\bprotect\w*\b[^.\n]{0,40}\bfrom\b[^.\n]{0,40}injection\b/i,
    noun: /inject/,
  },
  {
    label: 'journal-as-backup claim',
    pattern: /\bjournal\b[^.\n]{0,80}\b(backups?|back\s?ups?)\b/i,
    noun: /backup/,
  },
];

// A negated disclosure is honest ("no isolation", "not a backup") — but
// only when the negation precedes and governs the claimed noun within a
// short window. A trailing contrast ("provides isolation, not just
// speed") still flags: the "not" governs "speed", not "isolation".
const NEGATION_TOKENS = new Set([
  'no',
  'not',
  'never',
  'without',
  'honest',
  'refuse',
  'refuses',
  'refused',
  'unsupported',
  'warning',
  'warn',
  'warns',
  'guardrail',
  'guardrails',
]);
const NEGATION_PREFIXES = ['misconfigur'];
const NEGATION_WINDOW_TOKENS = 6;

function isNegated(line: string, noun: RegExp): boolean {
  // Hyphen/slash/colon compounds split too: kebab-case `no-isolation`
  // and scope ids like `limit:no-injection-prevention` carry the same
  // negation as the spaced form.
  const tokens = line
    .toLowerCase()
    .split(/\s+/)
    .flatMap((chunk) => chunk.split(/[-/:]/))
    .map((token) => token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter((token) => token.length > 0);
  const nounIndex = tokens.findIndex((token) => noun.test(token));
  if (nounIndex === -1) {
    return false;
  }
  const start = Math.max(0, nounIndex - NEGATION_WINDOW_TOKENS);
  return tokens
    .slice(start, nounIndex)
    .some(
      (token) =>
        NEGATION_TOKENS.has(token) ||
        token.endsWith("n't") ||
        NEGATION_PREFIXES.some((prefix) => token.startsWith(prefix)),
    );
}

export function findClaimViolations(line: string): string[] {
  return CLAIM_RULES.filter(
    (rule) => rule.pattern.test(line) && !isNegated(line, rule.noun),
  ).map((rule) => rule.label);
}

// Scope: every non-test source under the repo root — .ts/.tsx/.js/.mjs
// implementation plus .md docs (README, policies, roles, examples,
// .kubic roles). node_modules, dist, .git, coverage, and pi (upstream
// reference, not Kubic) are excluded. Violation SAMPLES live in this
// *.test.ts file, which the scan skips.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.md'];
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'pi',
]);
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.test.js', '.test.md'];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) {
          walk(full);
        }
      } else if (
        SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext)) &&
        !TEST_FILE_SUFFIXES.some((suffix) => full.endsWith(suffix))
      ) {
        out.push(full);
      }
    }
  };
  walk(root);
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

  it('flags block/stop/sandbox-verb bypasses (verified-live)', () => {
    expect(
      findClaimViolations(
        'the runtime stops attacks through hardware-backed containment',
      ),
    ).not.toEqual([]);
    expect(
      findClaimViolations(
        'our agent blocks exfiltration with full process isolation',
      ),
    ).not.toEqual([]);
    expect(
      findClaimViolations(
        'the worker sandboxes untrusted code for strong isolation',
      ),
    ).not.toEqual([]);
  });

  it('flags trailing-negation contrasts, allows preceding negation', () => {
    // The "not" governs "speed", not "isolation" — still a claim.
    expect(
      findClaimViolations('provides isolation, not just speed'),
    ).not.toEqual([]);
    expect(findClaimViolations('no isolation here')).toEqual([]);
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

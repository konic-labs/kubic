// CI grep-gate: no string may claim solo isolation, solo containment,
// or injection prevention (issue #58; §59.1). Claim patterns are
// verb/subject-anchored so honest senses keep passing: tracing span
// isolation, unicode isolates, "not a sandbox" guardrails, Phase-4 MCP
// containment requirements, and negated disclosures ("no isolation").
// Negation is proximity-aware: it must precede the claimed noun within
// a token window, so trailing contrasts still fail. Every non-test
// source plus markdown docs are scanned; violation SAMPLES live in
// this *.test.ts file, which the scan skips.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../exec/src/test-support/git-sandbox.js';

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

// Scope: tracked non-test sources under the repo root — .ts/.tsx/.js/.mjs
// implementation plus .md docs (README, policies, roles, examples,
// .kubic roles). The listing comes from `git ls-files` (issue #375), so
// untracked tool state — .claude/worktrees, .serena, .beads, a retained
// orchestrator worktree — can never flag the gate or slow the scan, and a
// checkout with worktrees scans exactly the fresh-clone set. `.kubic/` is
// mixed (config.toml + roles/*.md are committed, run state is ignored),
// so only the tracked half is a claims surface. Violation SAMPLES live in
// this *.test.ts file, which the scan skips.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.md'];
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'pi',
  // Generated artifacts: Stryker's sandbox copies (with live mutants) and
  // mutation reports are not product claims surfaces.
  '.stryker-tmp',
  'reports',
  // Agent/tooling state, never product surfaces (issue #375). These only
  // matter to the no-git fallback walk — `git ls-files` never lists them.
  // `.kubic/` stays listed: config.toml + roles/*.md are committed.
  '.claude',
  '.serena',
  '.beads',
]);
// Dev-tooling sources (design explorers, notes apps) are not product
// claims surfaces — their UI strings describe the tool itself.
const EXCLUDED_PATH_SEGMENTS = ['docs/design/tools'];
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.test.js', '.test.md'];

// Lines reviewed by a human and judged honest: each entry names the file
// suffix, a pattern the line must still match (so drift re-flags), and
// the justification. Keep this list empty by default — add only with a
// quoted reason pointing at the explicit denial in the same line.
const REVIEWED_EXCEPTIONS: Array<{
  fileSuffix: string;
  pattern: string;
  reason: string;
}> = [
  {
    fileSuffix: 'docs/design/kubic-overview.md',
    pattern: 'prompt-injection prevention system.*does not prevent injection',
    reason: 'NOT-list entry: explicitly denies prevention in the same line',
  },
  {
    fileSuffix: 'docs/design/kubic-overview.md',
    pattern: 'isolated-vm.*refused until then',
    reason: 'Phase-4 roadmap entry: explicitly refused until containment lands',
  },
];

function isReviewedException(file: string, line: string): boolean {
  return REVIEWED_EXCEPTIONS.some(
    (entry) =>
      file.endsWith(entry.fileSuffix) && new RegExp(entry.pattern).test(line),
  );
}

function findFileViolations(files: string[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (isReviewedException(file, line)) {
        return;
      }
      for (const label of findClaimViolations(line)) {
        failures.push(`${file}:${index + 1} [${label}] ${line.trim()}`);
      }
    });
  }
  return failures;
}

// One walk per run: both repo-wide tests share the listing.
const sourceFileCache = new Map<string, string[]>();

// Temp roots for the hermetic scan-scope tests below, removed after each.
const tempRoots: string[] = [];

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A line that violates the isolation-guarantee rule, for scope fixtures.
const VIOLATING_LINE = 'solo runs in an isolated sandbox for safety';

// The shared git sandbox (issue #420) replaces this file's former
// hand-rolled deterministic-git env: one scrubbed-env helper for every
// real-git test. The driver is lazy (plain, never injected — no production
// code here shells git) and disposed after each test.
let driver: GitSandbox | undefined;

function git(
  args: string[],
  opts?: { readonly cwd?: string; readonly maxBuffer?: number },
): string {
  driver ??= createGitSandbox();
  return driver.git(args, opts);
}

function initFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'honest-claims-'));
  tempRoots.push(root);
  git(['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

function isSourcePath(path: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) &&
    !TEST_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  );
}

// Tracked files via git, or null when git cannot answer (not a repo,
// Stryker's gitignored sandbox copy — see AGENTS.md Pitfalls). Null
// means "fall back to the walk", never "scan nothing".
function trackedSourceFiles(root: string): string[] | null {
  if (process.env.STRYKER_MUTATOR_WORKER) {
    return null;
  }
  try {
    const out = git(['-C', root, 'ls-files', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .split('\0')
      .filter((rel) => rel.length > 0)
      .map((rel) => join(root, rel))
      .filter(isSourcePath);
  } catch {
    return null;
  }
}

// `.gitignore` directory patterns as a walk predicate (issue #375): the
// no-git fallback honors the same ignores git would. Only directory
// patterns (`foo/`, `.kubic/sessions/`) participate; file globs and `!`
// negations are out of scope for a best-effort fallback.
function gitignoreDirExcluded(root: string): (relPath: string) => boolean {
  let patterns: string[] = [];
  try {
    patterns = readFileSync(join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith('#') &&
          !line.startsWith('!') &&
          line.endsWith('/'),
      )
      .map((line) => line.replace(/^\/+|\/+$/g, ''))
      .filter((line) => line.length > 0);
  } catch {
    patterns = [];
  }
  return (relPath: string) =>
    patterns.some(
      (pattern) => relPath === pattern || relPath.startsWith(`${pattern}/`),
    );
}

function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const gitignored = gitignoreDirExcluded(root);
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const relPath = rel === '' ? entry : `${rel}/${entry}`;
      if (statSync(full).isDirectory()) {
        if (
          !EXCLUDED_DIRS.has(entry) &&
          !gitignored(relPath) &&
          !EXCLUDED_PATH_SEGMENTS.some((segment) => relPath === segment) &&
          // Nested git repos and linked worktrees (a `.git` file) hold
          // other checkouts' files, never this tree's claims. (`full`
          // is always below the root here; the root's own `.git` is
          // already excluded above by name.)
          !existsSync(join(full, '.git'))
        ) {
          walk(full, relPath);
        }
      } else if (isSourcePath(full)) {
        out.push(full);
      }
    }
  };
  walk(root, '');
  return out;
}

function sourceFiles(root: string): string[] {
  const cached = sourceFileCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const out = trackedSourceFiles(root) ?? walkSourceFiles(root);
  sourceFileCache.set(root, out);
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
    const files = sourceFiles(root);
    // Canary: a wrong root would pass vacuously over zero product files.
    expect(files.some((file) => file.endsWith('limits/solo-warning.ts'))).toBe(
      true,
    );
    expect(findFileViolations(files)).toEqual([]);
  });

  it('scans tracked files only: untracked tool state never flags (issue #375)', () => {
    const root = initFixtureRepo();
    writeFileSync(join(root, 'clean.md'), '# clean\n');
    git(['add', 'clean.md'], { cwd: root });
    // Untracked claim-violating files: agent tool state and a stray note.
    mkdirSync(join(root, '.claude', 'worktrees', 'x'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'worktrees', 'x', 'claim.md'),
      `${VIOLATING_LINE}\n`,
    );
    writeFileSync(join(root, 'scratch-note.md'), `${VIOLATING_LINE}\n`);
    const files = sourceFiles(root);
    // The tracked file is scanned; nothing untracked is listed — the
    // count on a checkout with worktrees equals a fresh clone's.
    expect(files.some((file) => file.endsWith('clean.md'))).toBe(true);
    expect(files.some((file) => file.includes('.claude'))).toBe(false);
    expect(files.some((file) => file.endsWith('scratch-note.md'))).toBe(false);
    expect(findFileViolations(files)).toEqual([]);
  });

  it('falls back to a tool-state-free walk without git (issue #375)', () => {
    // No repo here: git ls-files fails, so the walk takes over — minus
    // dot-dir tool state and nested worktrees.
    const root = mkdtempSync(join(tmpdir(), 'honest-claims-'));
    tempRoots.push(root);
    writeFileSync(join(root, 'clean.ts'), 'export const ok = 1;\n');
    mkdirSync(join(root, '.serena'), { recursive: true });
    writeFileSync(join(root, '.serena', 'claim.md'), `${VIOLATING_LINE}\n`);
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere\n');
    writeFileSync(join(root, 'wt', 'claim.md'), `${VIOLATING_LINE}\n`);
    const files = sourceFiles(root);
    expect(files.some((file) => file.endsWith('clean.ts'))).toBe(true);
    expect(files.some((file) => file.includes('.serena'))).toBe(false);
    expect(files.some((file) => file.includes(`${'wt'}/claim.md`))).toBe(false);
    expect(findFileViolations(files)).toEqual([]);
  });

  it('falls back to the walk under Stryker, where git is unavailable (issue #375)', () => {
    vi.stubEnv('STRYKER_MUTATOR_WORKER', 'true');
    const root = initFixtureRepo();
    writeFileSync(join(root, 'clean.ts'), 'export const ok = 1;\n');
    git(['add', 'clean.ts'], { cwd: root });
    mkdirSync(join(root, '.beads'), { recursive: true });
    writeFileSync(join(root, '.beads', 'claim.md'), `${VIOLATING_LINE}\n`);
    // git would list only clean.ts; the walk lists it too, minus .beads.
    const files = sourceFiles(root);
    expect(files.some((file) => file.endsWith('clean.ts'))).toBe(true);
    expect(files.some((file) => file.includes('.beads'))).toBe(false);
    expect(findFileViolations(files)).toEqual([]);
  });

  it('reviewed exceptions still match their justification patterns', () => {
    // Exceptions are drift-pinned: if the line changes so the denial is
    // gone, the exception stops applying and the scan re-flags it.
    // Resolved directly, not via any listing (issue #375 review): the
    // design doc is gitignored, so neither the tracked listing nor the
    // gitignore-aware walk contains it — filtering a listing would pin
    // nothing and this test would always `continue`.
    for (const entry of REVIEWED_EXCEPTIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      const file = join(process.cwd(), entry.fileSuffix);
      if (!existsSync(file)) {
        // File absent here (e.g. gitignored design docs in worktrees
        // and fresh clones) — nothing to pin.
        continue;
      }
      const matched = readFileSync(file, 'utf8')
        .split('\n')
        .some(
          (line) =>
            new RegExp(entry.pattern).test(line) &&
            findClaimViolations(line).length > 0,
        );
      expect(matched).toBe(true);
    }
  });
});

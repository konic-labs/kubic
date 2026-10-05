// Built-in benchmark suites (issue #53; design §48, §76.1).
// One executable suite per category (issue #262): each carries a FIXTURE —
// the prompt the lane runs, the files the fixture workspace starts with,
// and the §48 gate command(s) that decide the verdict — so `kubic
// benchmark` and `kubic eval --task` run real work through the solo lane
// instead of refusing. Suites that need a capability the binary does not
// ship (a live PTY) are marked stub: true and reported as skipped, never
// as passed work. Community suites follow the same shape (see
// COMMUNITY.md).
import type { EvalCategory } from './categories.js';

// The §48 gate commands the run verifier executes in the fixture workspace
// after the run settles (exit 0 = pass). Structurally the host verifier's
// VerifyCommands; the eval package cannot import host (dep direction), so
// the shape is restated here.
export type SuiteVerifyCommands = Partial<
  Record<'tests' | 'build' | 'lint' | 'typecheck', string>
>;

export interface EvalSuiteFixture {
  // The prompt handed to the lane.
  prompt: string;
  // The files the fixture workspace starts with (relative path → content).
  files: Record<string, string>;
  // At least one gate command, so the suite has a verdict.
  verify: SuiteVerifyCommands;
  // Per-command bound; absent means the verifier default (10 minutes).
  timeoutMs?: number;
}

export interface EvalSuite {
  id: string;
  category: EvalCategory;
  title: string;
  stub: boolean;
  description: string;
  fixture?: EvalSuiteFixture;
}

export const EVAL_SUITES: readonly EvalSuite[] = [
  {
    id: 'swe-bench-mini',
    category: 'swe',
    title: 'SWE mini (faux)',
    stub: false,
    description:
      'Minimal coding-task signal: the fix file lands and the gate passes.',
    fixture: {
      prompt:
        'faux:tool write {"path":"src/fix.ts","content":"export const fixed = true;\\n"}',
      files: {},
      verify: { tests: 'test -f src/fix.ts' },
    },
  },
  {
    id: 'repo-mod-rename',
    category: 'repo-mod',
    title: 'Repo modification (faux)',
    stub: false,
    description: 'Cross-file edit stays within the granted worktree.',
    fixture: {
      prompt: 'faux:tool bash {"command":"mv src/old.ts src/new.ts"}',
      files: { 'src/old.ts': 'export const old = 1;\n' },
      verify: { tests: 'test -f src/new.ts && test ! -f src/old.ts' },
    },
  },
  {
    id: 'bugfix-repro',
    category: 'bugfix',
    title: 'Bugfix with repro (faux)',
    stub: false,
    description: 'Failing-first repro turns green after the fix.',
    fixture: {
      prompt: 'faux:tool write {"path":"answer.txt","content":"42\\n"}',
      files: { 'check.sh': 'grep -q "^42$" answer.txt\n' },
      verify: { tests: 'sh check.sh' },
    },
  },
  {
    id: 'refactor-extract',
    category: 'refactor',
    title: 'Refactor extract (faux)',
    stub: false,
    description: 'Behavior-preserving extract keeps the suite green.',
    fixture: {
      prompt:
        'faux:tool write {"path":"src/util.ts","content":"export const add = (a, b) => a + b;\\n"}',
      files: { 'src/main.ts': 'export const add = (a, b) => a + b;\n' },
      verify: { tests: 'test -f src/util.ts' },
    },
  },
  {
    id: 'testgen-cover',
    category: 'testgen',
    title: 'Test generation (faux)',
    stub: false,
    description: 'Generated tests cover the new branch.',
    fixture: {
      prompt:
        'faux:tool write {"path":"test/cover.test.ts","content":"test(\\"covers\\", () => {});\\n"}',
      files: {},
      verify: {
        tests:
          'test -f test/cover.test.ts && grep -q covers test/cover.test.ts',
      },
    },
  },
  {
    id: 'review-diff',
    category: 'review',
    title: 'Review diff (faux)',
    stub: false,
    description: 'Findings cite the diff lines they flag.',
    fixture: {
      prompt:
        'faux:tool write {"path":"review.md","content":"src/a.ts:1: unused import\\n"}',
      files: { 'src/a.ts': 'export const a = 1;\n' },
      verify: { tests: 'grep -q "src/a.ts" review.md' },
    },
  },
  {
    id: 'terminal-live',
    category: 'terminal',
    title: 'Terminal live session',
    stub: true,
    description: 'Needs a live PTY; stub until headless terminal replay lands.',
  },
  {
    id: 'agentic-live',
    category: 'agentic',
    title: 'Multi-step agent loop (faux)',
    stub: false,
    description:
      'One tool step plus a completion, verified in the worktree (faux).',
    fixture: {
      prompt: 'faux:tool bash {"command":"echo step-1 > steps.txt"}',
      files: {},
      verify: { tests: 'test -f steps.txt && grep -q step-1 steps.txt' },
    },
  },
];

// §73's `--suite swe` selector (issue #262): a suite id, a category name,
// or `all`/absent (every suite). Undefined means no suite and no category
// matches — the caller refuses by name rather than inventing a fallback.
export function resolveSuites(
  selector: string | undefined,
): EvalSuite[] | undefined {
  if (selector === undefined || selector === 'all') return [...EVAL_SUITES];
  const byId = EVAL_SUITES.find((suite) => suite.id === selector);
  if (byId !== undefined) return [byId];
  const byCategory = EVAL_SUITES.filter((suite) => suite.category === selector);
  return byCategory.length === 0 ? undefined : byCategory;
}

export function findSuite(id: string): EvalSuite | undefined {
  return EVAL_SUITES.find((suite) => suite.id === id);
}

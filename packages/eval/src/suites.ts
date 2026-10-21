// Built-in benchmark suites.
// One executable suite per category: each carries a FIXTURE — the task
// the lane runs (a plain-language task for a real model, a scripted one for
// the faux provider), the files the fixture workspace starts with, and the
// gate command(s) that decide the verdict — so `kubic benchmark` and
// `kubic eval --task` run real work through the lane instead of refusing.
// Suites that need a capability the binary does not ship (a live PTY) are
// marked stub: true and reported as skipped, never as passed work.
// Community suites follow the same shape (see COMMUNITY.md).
import type { EvalCategory } from './categories.js';

// The gate commands the run verifier executes in the fixture workspace
// after the run settles (exit 0 = pass). Structurally the host verifier's
// VerifyCommands; the eval package cannot import host (dep direction), so
// the shape is restated here.
type SuiteVerifyCommands = Partial<
  Record<'tests' | 'build' | 'lint' | 'typecheck', string>
>;

interface EvalSuiteFixture {
  // The task a real model is given: plain language, answerable from the
  // fixture files, and passing the gates when done right.
  task: string;
  // The scripted task the faux provider runs instead (it cannot read prose),
  // so the matrix stays deterministic in CI.
  fauxPrompt: string;
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

/** @internal */
export const EVAL_SUITES: readonly EvalSuite[] = [
  {
    id: 'swe-bench-mini',
    category: 'swe',
    title: 'SWE mini',
    stub: false,
    description:
      'Minimal coding-task signal: the fix file lands and the gate passes.',
    fixture: {
      task: 'Create the file src/fix.ts exporting a constant named `fixed` set to `true`.',
      fauxPrompt:
        'faux:tool write {"path":"src/fix.ts","content":"export const fixed = true;\\n"}',
      files: {},
      verify: { tests: 'test -f src/fix.ts' },
    },
  },
  {
    id: 'repo-mod-rename',
    category: 'repo-mod',
    title: 'Repo modification',
    stub: false,
    description: 'Cross-file edit stays within the granted worktree.',
    fixture: {
      task: 'Rename src/old.ts to src/new.ts, keeping its contents unchanged.',
      fauxPrompt: 'faux:tool bash {"command":"mv src/old.ts src/new.ts"}',
      files: { 'src/old.ts': 'export const old = 1;\n' },
      verify: { tests: 'test -f src/new.ts && test ! -f src/old.ts' },
    },
  },
  {
    id: 'bugfix-repro',
    category: 'bugfix',
    title: 'Bugfix with repro',
    stub: false,
    description: 'Failing-first repro turns green after the fix.',
    fixture: {
      task: 'The check script check.sh fails. Read it, then make it pass by creating the file it expects with the right content.',
      fauxPrompt: 'faux:tool write {"path":"answer.txt","content":"42\\n"}',
      files: { 'check.sh': 'grep -q "^42$" answer.txt\n' },
      verify: { tests: 'sh check.sh' },
    },
  },
  {
    id: 'refactor-extract',
    category: 'refactor',
    title: 'Refactor extract',
    stub: false,
    description: 'Behavior-preserving extract keeps the suite green.',
    fixture: {
      task: 'Extract the `add` function from src/main.ts into a new module src/util.ts that exports it.',
      fauxPrompt:
        'faux:tool write {"path":"src/util.ts","content":"export const add = (a, b) => a + b;\\n"}',
      files: { 'src/main.ts': 'export const add = (a, b) => a + b;\n' },
      verify: { tests: 'test -f src/util.ts' },
    },
  },
  {
    id: 'testgen-cover',
    category: 'testgen',
    title: 'Test generation',
    stub: false,
    description: 'Generated tests cover the new branch.',
    fixture: {
      task: 'Write a test file test/cover.test.ts containing a test named "covers".',
      fauxPrompt:
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
    title: 'Review diff',
    stub: false,
    description: 'Findings cite the diff lines they flag.',
    fixture: {
      task: 'Review src/a.ts and write your findings to review.md, citing each one as src/a.ts:<line>.',
      fauxPrompt:
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
    title: 'Multi-step agent loop',
    stub: false,
    description: 'One tool step plus a completion, verified in the worktree.',
    fixture: {
      task: 'Use the shell to write the text step-1 into a new file steps.txt.',
      fauxPrompt: 'faux:tool bash {"command":"echo step-1 > steps.txt"}',
      files: {},
      verify: { tests: 'test -f steps.txt && grep -q step-1 steps.txt' },
    },
  },
];

// 's `--suite swe` selector: a suite id, a category name,
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

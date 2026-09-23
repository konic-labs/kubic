// Built-in benchmark suites (issue #53; design §48, §76.1).
// One executable suite per category. Suites that need a live environment
// and cannot run faux-only are marked stub: true — the benchmark runner
// reports them as skipped (never as passed work) so the matrix stays
// honest. Community suites follow the same shape (see COMMUNITY.md).
import type { EvalCategory } from './categories.js';

export interface EvalSuite {
  id: string;
  category: EvalCategory;
  title: string;
  stub: boolean;
  description: string;
}

export const EVAL_SUITES: readonly EvalSuite[] = [
  {
    id: 'swe-bench-mini',
    category: 'swe',
    title: 'SWE mini (faux)',
    stub: false,
    description: 'Minimal coding-task signal: faux run must complete.',
  },
  {
    id: 'repo-mod-rename',
    category: 'repo-mod',
    title: 'Repo modification (faux)',
    stub: false,
    description: 'Cross-file edit stays within the granted worktree.',
  },
  {
    id: 'bugfix-repro',
    category: 'bugfix',
    title: 'Bugfix with repro (faux)',
    stub: false,
    description: 'Failing-first repro turns green after the fix.',
  },
  {
    id: 'refactor-extract',
    category: 'refactor',
    title: 'Refactor extract (faux)',
    stub: false,
    description: 'Behavior-preserving extract keeps the suite green.',
  },
  {
    id: 'testgen-cover',
    category: 'testgen',
    title: 'Test generation (faux)',
    stub: false,
    description: 'Generated tests cover the new branch.',
  },
  {
    id: 'review-diff',
    category: 'review',
    title: 'Review diff (faux)',
    stub: false,
    description: 'Findings cite the diff lines they flag.',
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
    stub: true,
    description: 'Needs a live model; stub while faux-only in CI.',
  },
];

export function findSuite(id: string): EvalSuite | undefined {
  return EVAL_SUITES.find((suite) => suite.id === id);
}

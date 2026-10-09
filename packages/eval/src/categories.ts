// Eval categories.
// The eight benchmark categories every matrix run covers.
/** @internal */
export const EVAL_CATEGORIES = [
  'swe',
  'repo-mod',
  'bugfix',
  'refactor',
  'testgen',
  'review',
  'terminal',
  'agentic',
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export function isEvalCategory(value: string): value is EvalCategory {
  return (EVAL_CATEGORIES as readonly string[]).includes(value);
}

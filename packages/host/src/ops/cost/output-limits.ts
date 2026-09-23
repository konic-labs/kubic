// (6) output limits (issue #56; §62 lever 6).
// Bounded outputs cap cost per response. Over-long output truncates with
// an explicit marker — never silently. Pure, faux-only.

export function validateOutputLimit(maxChars: number): number {
  if (
    typeof maxChars !== 'number' ||
    !Number.isFinite(maxChars) ||
    !(maxChars > 0)
  ) {
    throw new OutputLimitError('output limit must be a positive number');
  }
  return maxChars;
}

export class OutputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputLimitError';
  }
}

export function applyOutputLimit(text: string, maxChars: number): string {
  const limit = validateOutputLimit(maxChars);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated: output limit ${limit} chars]`;
}

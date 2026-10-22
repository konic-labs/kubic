// Redacting secret shapes from block reasons and summaries.
import { redactSecrets } from '@kubic/core/secret-shapes';

export { redactSecrets };

// Reasons persist into the trajectory, so commands and raw errors are
// truncated and secret-shaped values redacted before they become blocks.
export function redactReason(value: string): string {
  const short = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return redactSecrets(short);
}

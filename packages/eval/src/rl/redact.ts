// Dataset records leave the machine (training runs, an ML team), so every
// string in a record goes through the persisted-text redactor before it is
// written: key shapes, PEM blocks, URL userinfo, authorization values and
// secret-named assignments. It over-redacts on purpose: a code sample's
// `password: string` field reads `password: [REDACTED]`.
import { redactSecrets } from '@kubic/core/secret-shapes';

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, leaf]) => [key, redactValue(leaf)]),
    );
  }
  return value;
}

export function redactRecord<T>(record: T): T {
  return redactValue(record) as T;
}

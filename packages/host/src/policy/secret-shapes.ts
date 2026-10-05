// Moved to @kubic/core (issue #192) so the WORKER's redactor can compose the
// same shape table — the dependency direction is core ← host/worker, and a
// worker → host import would break `npm run lint:deps`. Kept as a re-export
// so the host call sites (audit, policy, ledger, cost/perf CLI) keep their
// path and the existing tests still exercise the table.
export {
  containsSecretShape,
  findSecretShapes,
  REDACTED_SECRET,
  redactSecretShapes,
} from '../../../core/src/secret-shapes.js';

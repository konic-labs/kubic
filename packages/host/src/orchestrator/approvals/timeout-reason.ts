// The shared timeout-reason marker (issue #129). Every producer of an
// approval-timeout denial interpolates THIS constant — never a copied
// literal — and every classifier reads the same constant, so producer and
// classifier cannot drift:
//   producers  — approvals.ts (the service bound), routing.ts (the
//   orchestrator routing decision), worker-asks.ts (the mailbox ask bound);
//   classifiers — classifyVerdict (worker-asks.ts) and the headless run's
//   approval terminus label (headless-run.ts).
// It lives in this leaf module so all of them can import it without an
// import edge pointing the wrong way (routing.ts must not import
// worker-asks.ts, which already imports routing.ts).
export const TIMEOUT_REASON_MARKER = 'timed out';

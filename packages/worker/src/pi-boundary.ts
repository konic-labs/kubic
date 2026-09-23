// packages/worker/src/pi-boundary.ts — the SINGLE choke point for Pi harness
// imports (design §65). No other Kubic file may import `@earendil-works/*`
// modules; `scripts/dep-lint.mjs` rejects Pi imports everywhere else and
// CODEOWNERS flags every diff touching this file for maintainer review.
//
// Approved seams (public Pi surface only — never Pi deep internals):
// - ExecutionEnv (sandboxed shell + filesystem for worker runs)
// - *Operations (tool implementations the worker exposes to the lane)
// - before_tool hook (approval interception point)
// - deferred approvals (async approval client contract)
//
// Per-export justification template — copy this block above EVERY re-export
// added to this file:
//
//   JUSTIFICATION:
//     seam: <Pi package + export path, e.g. @earendil-works/pi-agent-core#ExecutionEnv>
//     used by: <Kubic module that needs it, e.g. packages/worker/src/session.ts>
//     why Pi has no alternative: <one line — what breaks if we reimplement>
//     review: <link to the approving issue/PR discussion>
//
// Real re-exports land here with the worker wiring (EPIC B/E). Until then this
// file intentionally exports nothing.

export {};

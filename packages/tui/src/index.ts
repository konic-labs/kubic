// §3.1 (UI is not the runtime): this package is presentation only.
// It must import contracts from @kubic/core and never import
// @kubic/host or @kubic/worker implementation — enforced by
// scripts/dep-lint.mjs (issue #2).
export {};

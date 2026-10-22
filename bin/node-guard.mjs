// Node-version guard for the `kubic` launcher.
//
// Extracted from bin/kubic.js so the comparison is table-testable without
// an old runtime (scripts/binary-contract.test.mjs) while the launcher
// itself stays plain statements: on a runtime below 22.19 the dynamic
// import of the build output can only fail as a raw parser SyntaxError —
// the guard turns that into the named requirement first (`engines` is
// advisory; the launcher is the one place that can check cheaply before
// parsing anything exotic).
//
// Imported by bin/kubic.js as a static import: this module must never gain
// a top-level await, and must stay importable on any ESM-capable runtime.

// The floor from the root manifest's `engines.node` (>=22.19). One
// predicate, two callers: the launcher's runtime check and the table test.
export function nodeVersionSupported(version) {
  const [major = 0, minor = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  // Unparsable input fails closed (NaN compares false either way).
  return major > 22 || (major === 22 && minor >= 19);
}

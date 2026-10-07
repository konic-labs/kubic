#!/usr/bin/env node
// `kubic` executable: committed wrapper so the command works
// without a global install. The real entry is the tsc build output —
// run `npm run build` first (see the README install section).
//
// Node guard BEFORE any top-level await: on a runtime below
// 22.19 the dynamic import below is a raw parser SyntaxError — the guard
// turns that into the named requirement instead. Plain statements only
// above the import (asserted by scripts/binary-contract.test.mjs); the
// refusal line is pinned end to end by scripts/binary-contract.mjs.
import { nodeVersionSupported } from './node-guard.mjs';

if (!nodeVersionSupported(process.versions.node)) {
  console.error(
    `kubic: node >= 22.19 required (running ${process.versions.node}) — see the README install section`,
  );
  process.exit(1);
}

try {
  await import('../dist/apps/kubic/src/main.js');
} catch (error) {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  ) {
    console.error('kubic: build output missing — run `npm run build` first.');
    process.exit(1);
  }
  throw error;
}

#!/usr/bin/env node
// `kubic` executable: committed wrapper so the command works
// without a global install. The real entry is the bundled build output,
// dist/kubic.js (scripts/build.mjs) — run `npm run build` first (see the
// README install section).
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

// dist/kubic.js ships its source map (dist/kubic.js.map). Only a debug run
// prints stacks (KUBIC_DEBUG=1), so only that run maps them back to the
// TypeScript sources; enabling the maps costs startup time on every other run.
if (process.env.KUBIC_DEBUG === '1') {
  process.setSourceMapsEnabled(true);
}

try {
  await import('../dist/kubic.js');
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

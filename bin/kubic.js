#!/usr/bin/env node
// `kubic` executable: the committed wrapper over the bundled build output,
// dist/kubic.js (scripts/build.mjs). A clone builds it with `npm run build`;
// an npm install ships it.
//
// Node guard BEFORE any top-level await: on a runtime below
// 22.19 the dynamic import below is a raw parser SyntaxError — the guard
// turns that into the named requirement instead. Plain statements only
// above the import (asserted by scripts/binary-contract.test.mjs); the
// refusal line is pinned end to end by scripts/binary-contract.mjs.
import { existsSync } from 'node:fs';
import { nodeVersionSupported } from './node-guard.mjs';

if (!nodeVersionSupported(process.versions.node)) {
  console.error(
    `kubic: node >= 22.19 required (running ${process.versions.node}) — see the README install section`,
  );
  process.exit(1);
}

// A missing bundle and a missing dependency need different fixes, so only
// the bundle check names the build.
if (!existsSync(new URL('../dist/kubic.js', import.meta.url))) {
  console.error(
    'kubic: build output missing (dist/kubic.js). In a clone, run `npm run build`; in an npm install, reinstall kubic.',
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
  // The bundle exists, so a module it cannot find is a dependency.
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  ) {
    console.error(`kubic: a dependency is missing: ${error.message}`);
    console.error('kubic: reinstall kubic, or run `npm ci` in a clone.');
    process.exit(1);
  }
  throw error;
}

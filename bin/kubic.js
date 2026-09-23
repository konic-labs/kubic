#!/usr/bin/env node
// `kubic` executable (issue #74): committed wrapper so the command works
// without a global install. The real entry is the tsc build output —
// run `npm run build` first (see the README install section).
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

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/*/src` is collected too (issue #135): the composition root's
    // dispatch seam is a testable surface, not a silently-unrun directory.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // No test may see the developer's provider credentials (issue #221):
    // the assembled catalog includes Pi's built-ins, which read env keys.
    setupFiles: ['./vitest.setup.mjs'],
    // Half the cores, not vitest's cores-1 default: several coding agents
    // often run the suite at once on one laptop. The suite is ~10s either way.
    maxWorkers: '50%',
    // Stryker instruments every expression, which makes CPU-bound tests
    // (e.g. the 8 MiB read-bound scan) several times slower on CI runners.
    testTimeout:
      process.env.STRYKER_MUTATOR_WORKER === undefined ? 5_000 : 30_000,
  },
});

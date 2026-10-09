import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // `@kubic/<pkg>/<subpath>` resolves through the package's `source` export
    // condition to src/*.ts, the same files the typecheck and the bundle read.
    conditions: ['source'],
  },
  test: {
    // `apps/*/src` is collected too: the composition root's
    // dispatch seam is a testable surface, not a silently-unrun directory.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // Hermetic env: temp HOME, no ambient KUBIC_* variables,
    // non-loopback TCP connects refused — see test/hermetic-env.ts. Credential-shaped
    // env vars are scrubbed first so no test can see
    // the developer's provider keys.
    globalSetup: ['./test/vitest-global-setup.ts'],
    // Fail any test that leaves a coloured TUI theme behind.
    setupFiles: [
      './vitest.setup.mjs',
      './test/vitest-setup.ts',
      './vitest.setup.ts',
    ],
    // Half the cores, not vitest's cores-1 default: several coding agents
    // often run the suite at once on one laptop. The suite is ~10s either way.
    maxWorkers: '50%',
    testTimeout: 5_000,
  },
});

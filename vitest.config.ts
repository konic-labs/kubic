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
    // Half the cores, not vitest's cores-1 default, so a run leaves room for
    // other work on the machine.
    maxWorkers: '50%',
    testTimeout: 5_000,
    // `npm run test:coverage`: the product's own sources, without the tests
    // and their support code.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test-support/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Floors a point under the measured coverage: a change that drops it
      // fails the run.
      thresholds: { statements: 92, branches: 85, functions: 93, lines: 93 },
    },
  },
});

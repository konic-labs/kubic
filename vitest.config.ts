import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/*/src` is collected too (issue #135): the composition root's
    // dispatch seam is a testable surface, not a silently-unrun directory.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // Half the cores, not vitest's cores-1 default: several coding agents
    // often run the suite at once on one laptop. The suite is ~10s either way.
    maxWorkers: '50%',
  },
});

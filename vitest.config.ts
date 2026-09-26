import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/*/src` is collected too (issue #135): the composition root's
    // dispatch seam is a testable surface, not a silently-unrun directory.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
});

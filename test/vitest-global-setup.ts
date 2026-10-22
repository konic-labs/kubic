// vitest globalSetup: one temp root per run, created and
// removed in the main process. Each test file's temp HOME lives under it,
// so a file whose afterAll never runs (every test skipped, or a worker
// SIGTERM'd at teardown) still leaves nothing behind in $TMPDIR.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    hermeticHomeRoot: string;
  }
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), 'kubic-test-homes-'));
  project.provide('hermeticHomeRoot', root);
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}

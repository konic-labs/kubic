// vitest setupFile (issue #377): every test file runs under a temp HOME,
// with no ambient KUBIC_* variables and non-loopback TCP connects refused
// (loopback is exempt, so a test-owned server is fine), so results never
// depend on the developer's installed skills, trust opt-in, or network. The
// temp HOME is removed after the file's last test; the run's home root
// (test/vitest-global-setup.ts) sweeps any a skipped file left.
import { afterAll, inject } from 'vitest';
import { isolateTestEnv } from './hermetic-env.js';

const hermetic = isolateTestEnv(inject('hermeticHomeRoot'));

afterAll(() => {
  hermetic.restore();
});

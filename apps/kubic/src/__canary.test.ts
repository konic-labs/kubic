// Collection canary (issue #135): this file exists ONLY to prove the
// vitest include list reaches `apps/kubic/src/` — before the include
// change it silently never ran. It is deliberately RED; it is deleted and
// replaced by the real dispatch suite in the next commit.
import { expect, it } from 'vitest';

it('canary: the app tree is collected (this must FAIL)', () => {
  expect(1).toBe(2);
});

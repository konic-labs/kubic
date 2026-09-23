// Kubic license identity (issue #59; §75.1): single source of truth for
// the MIT license id, so `kubic --version` and `kubic doctor` report the
// same license string that LICENSE and the package.json fields declare.
import { describe, expect, it } from 'vitest';
import {
  formatVersionLine,
  KUBIC_LICENSE,
  KUBIC_LICENSE_FILE,
} from './license.js';

describe('kubic license identity (issue #59)', () => {
  it('declares the MIT license id', () => {
    expect(KUBIC_LICENSE).toBe('MIT');
  });

  it('points at the root LICENSE file', () => {
    expect(KUBIC_LICENSE_FILE).toBe('LICENSE');
  });

  it('formats the --version line with version and license', () => {
    expect(formatVersionLine('0.0.0')).toBe('kubic 0.0.0 (license: MIT)');
  });
});

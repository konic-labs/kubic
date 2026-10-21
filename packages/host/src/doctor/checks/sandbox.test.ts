// `sandbox` in doctor: the mechanism in use, or why bash runs unconfined.
import { describe, expect, it } from 'vitest';
import { sandboxDoctorCheck } from './sandbox.js';

describe('sandboxDoctorCheck', () => {
  it('names the sandbox in use', () => {
    expect(sandboxDoctorCheck('auto', 'seatbelt')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('Seatbelt (sandbox-exec)'),
    });
  });

  it('warns when off, and fails a required sandbox the machine lacks', () => {
    expect(sandboxDoctorCheck('off', 'bubblewrap')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('bubblewrap (bwrap) is available'),
    });
    expect(sandboxDoctorCheck('required', undefined)).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('refuse to start'),
    });
    expect(sandboxDoctorCheck('auto', undefined)).toMatchObject({
      status: 'warn',
    });
  });
});

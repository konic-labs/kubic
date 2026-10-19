// Doctor's config section: unknown or unsupported
// keys fail closed with a named reason AND appear in doctor — nothing is
// silently ignored.
import { describe, expect, it } from 'vitest';
import {
  buildConfigDoctorInput,
  CONFIG_DOCTOR_ID,
  configDoctorProbe,
} from './config-doctor.js';

describe('doctor config section', () => {
  it('fails closed with the named reason when the config was refused', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        error: "layer 'global': unknown section '[telemetry]'",
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.id).toBe(CONFIG_DOCTOR_ID);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/unknown section '\[telemetry\]'/);
    expect(probe.detail).toMatch(/no defaults applied/);
  });

  it('reports trust and the ignore split on a healthy load', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [
          {
            key: 'model.provider',
            value: '"local"',
            layer: 'global',
            disposition: 'consumed',
          },
          {
            key: 'journal.retentionDays',
            value: '30',
            layer: 'project',
            disposition: 'consumed',
          },
        ],
        projectTrusted: true,
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/2 effective value\(s\)/);
    expect(probe.detail).toMatch(/project layer trusted/);
    expect(probe.detail).toMatch(/runtime ignore split complete/);
  });

  it('fails when runtime state is not ignored in this repo', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        ignoreSplitMissing: ['.kubic/audit/'],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/\.kubic\/audit\//);
  });

  it('flags an accepted key with no effect row at all', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [
          {
            key: 'model.provider',
            value: '"local"',
            layer: 'global',
            disposition: 'consumed',
          },
          {
            key: 'telemetry.endpoint',
            value: '"https://x"',
            layer: 'project',
            disposition: 'unknown',
          },
        ],
        projectTrusted: true,
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/no effect row/);
    expect(probe.detail).toMatch(/telemetry\.endpoint/);
    // The row that explains its key is never named.
    expect(probe.detail).not.toMatch(/model\.provider/);
  });

  it('reports an untrusted project layer without calling it a failure', () => {
    // Distrust is a posture, not a defect: the layer is simply absent.
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/project layer not trusted/);
  });

  it('names the store a project grant came from', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: true,
        projectTrust: {
          decision: true,
          envTrust: false,
          storePath: '/home/u/.kubic/trust.json',
        },
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain(
      'project layer trusted (recorded in /home/u/.kubic/trust.json)',
    );
  });

  it('names the remedies for an undecided or declined project layer', () => {
    const declined = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        projectTrust: {
          decision: false,
          envTrust: false,
          storePath: '/home/u/.kubic/trust.json',
        },
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(declined.ok).toBe(true);
    expect(declined.detail).toMatch(/declined/);
    expect(declined.detail).toContain("run 'kubic trust' to accept");

    const undecided = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        projectTrust: {
          decision: null,
          envTrust: false,
          storePath: '/home/u/.kubic/trust.json',
        },
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(undecided.ok).toBe(true);
    expect(undecided.detail).toMatch(/no decision recorded/);
    expect(undecided.detail).toContain('KUBIC_TRUST_PROJECT=1');
  });

  it('names a store error instead of reporting no decision', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        projectTrust: {
          decision: null,
          envTrust: false,
          storePath: '/home/u/.kubic/trust.json',
          storeError:
            'trust store /home/u/.kubic/trust.json is not valid JSON: bad',
        },
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain('not valid JSON');
    expect(probe.detail).not.toContain('no decision recorded');
  });
});

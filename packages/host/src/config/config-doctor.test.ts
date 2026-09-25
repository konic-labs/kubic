// Doctor's config section (issue #90, criterion 3): unknown or unsupported
// keys fail closed with a named reason AND appear in doctor — nothing is
// silently ignored. RED first.
import { describe, expect, it } from 'vitest';
import {
  buildConfigDoctorInput,
  CONFIG_DOCTOR_ID,
  configDoctorProbe,
} from './config-doctor.js';

describe('doctor config section (issue #90)', () => {
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

  it('reports budgets, trust and the ignore split on a healthy load', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [
          { key: 'model.provider', value: '"local"', layer: 'global' },
          { key: 'journal.retentionDays', value: '30', layer: 'project' },
        ],
        projectTrusted: true,
        budgetsConfigured: false,
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/2 effective value\(s\)/);
    expect(probe.detail).toMatch(/project layer trusted/);
    expect(probe.detail).toMatch(/budgets none/);
  });

  it('fails when runtime state is not ignored in this repo', () => {
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        budgetsConfigured: false,
        ignoreSplitMissing: ['.kubic/journal/', '.kubic/wt/'],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/\.kubic\/journal\//);
    expect(probe.detail).toMatch(/\.kubic\/wt\//);
  });

  it('reports an untrusted project layer without calling it a failure', () => {
    // Distrust is a posture, not a defect: the layer is simply absent.
    const probe = configDoctorProbe(
      buildConfigDoctorInput({
        values: [],
        projectTrusted: false,
        budgetsConfigured: false,
        ignoreSplitMissing: [],
        ignoreSplitApplicable: true,
      }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/project layer not trusted/);
  });
});

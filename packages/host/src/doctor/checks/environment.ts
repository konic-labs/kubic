// The environment checks: required tools on PATH, the platform the shell
// guards cover, and the licence line.

import { formatLicenseDetail } from '@kubic/core/license';
import type {
  DepProbe,
  DoctorCheck,
  DoctorReason,
  DoctorStatus,
} from '../types.js';

export function depChecks(probes: DepProbe[]): DoctorCheck[] {
  return probes.map((probe) => ({
    id: `dep:${probe.id}`,
    label: `dep ${probe.id}`,
    status: (probe.ok ? 'pass' : 'fail') as DoctorStatus,
    reason: (probe.ok ? 'ok' : 'deps-missing') as DoctorReason,
    detail: probe.detail ?? (probe.ok ? 'present' : 'missing'),
  }));
}

// License identity: Kubic is MIT-licensed. The check
// always passes — it surfaces the license at runtime and can never flip
// the doctor exit code. The static correspondence (LICENSE text and the
// package.json license fields matching these constants) is guarded by
// scripts/license.test.mjs instead of by a runtime probe.
export function licenseCheck(): DoctorCheck {
  return {
    id: 'license:kubic',
    label: 'license kubic',
    status: 'pass',
    reason: 'ok',
    detail: formatLicenseDetail(),
  };
}

// The platform posture. Every approval detector reads POSIX shell, so the bash
// tool runs on Linux and macOS and refuses to run on Windows, where cmd would
// run with no detector coverage.
export function platformCheck(platform: string): DoctorCheck {
  if (platform === 'win32') {
    return {
      id: 'platform:shell',
      label: 'platform shell',
      status: 'warn',
      reason: 'unsupported-platform',
      detail:
        'Windows is not supported: the bash tool refuses to run, because the approval detectors read POSIX shell commands only',
    };
  }
  return {
    id: 'platform:shell',
    label: 'platform shell',
    status: 'pass',
    reason: 'ok',
    detail: `${platform}: the bash tool runs bash (else sh), and the approval detectors read POSIX shell commands`,
  };
}

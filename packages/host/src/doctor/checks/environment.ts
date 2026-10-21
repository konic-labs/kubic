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
// tool runs bash on Linux and macOS, and on Windows a POSIX bash (Git Bash,
// else WSL) — refusing when there is none, since cmd would run with no
// detector coverage.
export function platformCheck(
  platform: string,
  // On Windows, the POSIX bash the tool runs through (`Git Bash`, `WSL`, a
  // path); absent: none was found.
  windowsBash?: string,
): DoctorCheck {
  if (platform === 'win32') {
    return windowsBash === undefined
      ? {
          id: 'platform:shell',
          label: 'platform shell',
          status: 'warn',
          reason: 'unsupported-platform',
          detail:
            'Windows without a POSIX bash: the bash tool refuses to run, because the approval detectors read POSIX shell commands only — install Git for Windows (Git Bash) or WSL, or set KUBIC_BASH',
        }
      : {
          id: 'platform:shell',
          label: 'platform shell',
          status: 'pass',
          reason: 'ok',
          detail: `win32: the bash tool runs through ${windowsBash}, and the approval detectors read POSIX shell commands`,
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

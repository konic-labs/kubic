// `sandbox`: whether the bash tool's commands run in the OS sandbox, and in
// which — or why they do not.

import type { DoctorCheck } from '../types.js';

export function sandboxDoctorCheck(
  mode: 'off' | 'auto' | 'required',
  detected: 'seatbelt' | 'bubblewrap' | undefined,
): DoctorCheck {
  const base = { id: 'sandbox', label: 'bash sandbox' } as const;
  const mechanism =
    detected === 'seatbelt' ? 'Seatbelt (sandbox-exec)' : 'bubblewrap (bwrap)';
  if (mode === 'off') {
    return {
      ...base,
      status: 'warn',
      reason: 'ok',
      detail: `off: bash commands run unconfined, as your user${detected === undefined ? '' : ` — ${mechanism} is available ([sandbox] mode = "auto")`}`,
    };
  }
  if (detected === undefined) {
    return {
      ...base,
      status: mode === 'required' ? 'fail' : 'warn',
      reason: mode === 'required' ? 'policy-mismatch' : 'ok',
      detail: `${mode}, but this machine has no sandbox (Seatbelt on macOS, bubblewrap on Linux)${mode === 'required' ? ': kubic run and kubic tui refuse to start' : ': bash commands run unconfined'}`,
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: `${mode}: bash commands run in ${mechanism} — writes confined to the workspace and temp, network only under network = "full", credential paths hidden`,
  };
}

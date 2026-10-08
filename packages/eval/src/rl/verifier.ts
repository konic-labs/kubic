// Reference verifier.
// tests-pass wired to the eval runner: the verdict reuses the eval
// package's own signal derivation (computeSignals/gatesPass)
// over the parsed trajectory export — never a re-guess. Unknown signals
// abstain, so an unverified run fails closed.
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { computeSignals, type GateSignal, gatesPass } from '../signals.js';

export interface VerifierVerdict {
  verdict: 'pass' | 'fail';
  tests: GateSignal;
}

export function referenceVerifier(exported: TrajectoryExport): VerifierVerdict {
  const signals = computeSignals(exported);
  const pass = signals.tests === 'pass' && gatesPass(signals);
  return { verdict: pass ? 'pass' : 'fail', tests: signals.tests };
}

// Production wiring for the command dispatch: one runner per command, built
// from the real process (cwd, env, streams) and the lanes. ./dispatch.ts
// stays a pure seam, so routing is testable with fakes; the runners live in
// ./runners/, one module per command group.

import {
  auditRunner,
  benchmarkRunner,
  costRunner,
  evalRunner,
  exportRunner,
  policyRunner,
  replayRunner,
} from './runners/analysis.js';
import { doctorRunner } from './runners/doctor.js';
import { gitRunner, journalRunner } from './runners/journal.js';
import { runRunner, sessionsRunner, tuiRunner } from './runners/session.js';
import {
  configRunner,
  keysRunner,
  modelsRunner,
  setupRunner,
  skillsRunner,
  trustRunner,
} from './runners/setup.js';
import type { ProdRunnerIo, ProdRunners } from './runners/shared.js';

export function createProdRunners(io: ProdRunnerIo): ProdRunners {
  return {
    sessions: sessionsRunner(io),
    git: gitRunner(io),
    journal: journalRunner(io),
    models: modelsRunner(io),
    setup: setupRunner(io),
    skills: skillsRunner(io),
    trust: trustRunner(io),
    keys: keysRunner(io),
    run: runRunner(io),
    tui: tuiRunner(io),
    doctor: doctorRunner(io),
    cost: costRunner(io),
    policy: policyRunner(io),
    config: configRunner(io),
    audit: auditRunner(io),
    eval: evalRunner(io),
    benchmark: benchmarkRunner(io),
    replay: replayRunner(io),
    export: exportRunner(io),
  };
}

// The command-handler contract, checked at the type level (`tsc` runs these
// assertions as part of the typecheck): every handler resolves to a
// CommandResult, and its exit code is the ExitCode union, so a handler cannot
// return a code the docs do not name.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  CommandResult,
  ExitCode,
} from '../../../../packages/core/src/cli/exit-codes.js';
import {
  runBenchmarkCommand,
  runEvalCommand,
} from '../../../../packages/eval/src/cli.js';
import { runExportCommand } from '../../../../packages/eval/src/export-cli.js';
import { runConfigCommand } from '../../../../packages/host/src/config/config-cli.js';
import { runDoctorCommand } from '../../../../packages/host/src/doctor.js';
import { runGitCommand } from '../../../../packages/host/src/git-cli.js';
import { runJournalCommand } from '../../../../packages/host/src/journal-cli.js';
import { runModelsCommand } from '../../../../packages/host/src/models-cli.js';
import { runCostCommand } from '../../../../packages/host/src/ops/cost/cost-cli.js';
import { runAuditCommand } from '../../../../packages/host/src/policy/audit-cli.js';
import { runPolicyCommand } from '../../../../packages/host/src/policy/policy-cli.js';
import { runReplayCommand } from '../../../../packages/host/src/replay/replay.js';
import { runRunCommand } from '../../../../packages/host/src/run-cli.js';
import { runSessionsCommand } from '../../../../packages/host/src/sessions-cli.js';
import { runSetupCommand } from '../../../../packages/host/src/setup-cli.js';
import { runSkillsCommand } from '../../../../packages/host/src/skills-cli.js';
import { runTrustCommand } from '../../../../packages/host/src/trust-cli.js';
import { prodFirstRunSetup } from '../setup-prod.js';
import { runTuiCommand } from '../tui-run.js';

describe('the exit-code contract', () => {
  it('ExitCode is exactly the documented codes', () => {
    expectTypeOf<ExitCode>().toEqualTypeOf<
      0 | 1 | 2 | 3 | 4 | 5 | 6 | 129 | 130 | 143
    >();
    expectTypeOf<7>().not.toExtend<ExitCode>();
    expectTypeOf<number>().not.toExtend<ExitCode>();
  });

  it('every command handler resolves to a CommandResult', () => {
    expectTypeOf(runConfigCommand).returns.toEqualTypeOf<CommandResult>();
    expectTypeOf(runSkillsCommand).returns.toEqualTypeOf<CommandResult>();
    expectTypeOf(runTrustCommand).returns.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runDoctorCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(runGitCommand).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runJournalCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runModelsCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runSessionsCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runSetupCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(runRunCommand).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(runTuiCommand).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runCostCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runPolicyCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runAuditCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runReplayCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runEvalCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runBenchmarkCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
    expectTypeOf(
      runExportCommand,
    ).returns.resolves.toEqualTypeOf<CommandResult>();
  });

  it('the first-run setup stops with a CommandResult or opens the TUI', () => {
    expectTypeOf(prodFirstRunSetup).returns.resolves.toEqualTypeOf<
      CommandResult | undefined
    >();
  });
});

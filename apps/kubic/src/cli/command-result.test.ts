// The command-handler contract, checked at the type level (`tsc` runs these
// assertions as part of the typecheck): every handler resolves to a
// CommandResult, and its exit code is the ExitCode union, so a handler cannot
// return a code the docs do not name.

import type { CommandResult, ExitCode } from '@kubic/core/cli/exit-codes';
import { runBenchmarkCommand, runEvalCommand } from '@kubic/eval/cli';
import { runExportCommand } from '@kubic/eval/export-cli';
import { runAuditCommand } from '@kubic/host/audit';
import {
  runConfigCommand,
  runSetupCommand,
  runTrustCommand,
} from '@kubic/host/config';
import { runCostCommand } from '@kubic/host/cost';
import { runDoctorCommand } from '@kubic/host/doctor';
import { runGitCommand } from '@kubic/host/git';
import { runJournalCommand } from '@kubic/host/journal';
import { runModelsCommand } from '@kubic/host/models';
import { runPolicyCommand } from '@kubic/host/policy';
import { runReplayCommand } from '@kubic/host/replay';
import { runRunCommand } from '@kubic/host/run';
import { runSessionsCommand } from '@kubic/host/sessions';
import { runSkillsCommand } from '@kubic/host/skills';
import { describe, expectTypeOf, it } from 'vitest';
import { prodFirstRunSetup } from '../setup-prod.js';
import { runTuiCommand } from '../tui/run.js';

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

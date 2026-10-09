// The production runners of the session commands (run, tui, sessions), and
// the lane deps `kubic run` and `kubic tui` boot with. Both builders are the
// real wiring tests go through, so a dropped projection fails a test.

import { homedir } from 'node:os';
import { isFancy } from '@kubic/core/cli/kit';
import { promptConfirm } from '@kubic/core/cli/prompt';
import { themeFor } from '@kubic/core/cli/theme';
import { runRunCommand } from '@kubic/host/run';
import { runSessionsCommand } from '@kubic/host/sessions';
import type { CliConfigResult } from '../config/load.js';
import { projectTrustFor } from '../config/load.js';
import {
  runtimeModelFrozen,
  runtimeModelPin,
  runtimePolicy,
} from '../config/model-selection.js';
import {
  installedPolicyClasses,
  installedPolicyDeps,
  runtimeApprovalDeps,
  runtimeCompactionDeps,
  runtimeLaneDeps,
  runtimeRunDeps,
  runtimeSkillsDeps,
  runtimeStreamTuning,
  runtimeSystemPromptSection,
  sessionRetentionDays,
} from '../config/projections.js';
import { runHeadlessPrompt } from '../run/command.js';
import type { HeadlessRunDeps } from '../run/options.js';
import { createRunProgress } from '../run/progress.js';
import type { TuiDepsInput } from '../tui/deps.js';
import { tuiDepsWithDefaults } from '../tui/deps.js';
import { runTuiCommand } from '../tui/run.js';
import type { ProdRunnerIo, ProdRunners } from './shared.js';
import { noteOverriddenModelPins, presentation } from './shared.js';

// The lane deps `kubic run` boots the headless runner with: every config
// projection the lane consumes, from the ONE config load. Exported so
// the wiring is tested through the same builder the runner calls — a test
// that hand-spreads these keys stays green when the production spread is
// dropped.
/** @internal */
export function prodRunDeps(cliConfig: CliConfigResult): HeadlessRunDeps {
  const enterprisePolicy = runtimePolicy(cliConfig);
  // The session compaction keys, threaded to the lane boot
  // below.
  const compaction = runtimeCompactionDeps(cliConfig);
  // The system prompt file section, read at load.
  const systemPromptSection = runtimeSystemPromptSection(cliConfig);
  // The `[model]` / `[roles.<name>]` request tuning
  // the headless boot resolves against the run's role. Undefined when
  // nothing is tuned — the lane then omits `settings.stream`.
  const streamTuning = runtimeStreamTuning(cliConfig);
  return {
    model: runtimeModelPin(cliConfig),
    ...(compaction === undefined ? {} : { compaction }),
    ...(systemPromptSection === undefined ? {} : { systemPromptSection }),
    ...(streamTuning === undefined ? {} : { streamTuning }),
    // Enterprise policy: the model gate, the role grant
    // check and the lane tool intersection all read this one resolved
    // object.
    ...(enterprisePolicy === undefined
      ? {}
      : { modelPolicy: enterprisePolicy }),
    ...runtimeRunDeps(cliConfig),
    // One per-path check gates the project models.json
    // and each ancestor skill root on the tree the files live in — never a
    // cwd boolean applied to ancestors.
    trustProject: projectTrustFor(cliConfig),
    // The shared lane projections — the configured agent id
    // (journal attribution) and the config-sourced role layers `--role`
    // merges under the document.
    ...runtimeLaneDeps(cliConfig),
    // The config `skills` projection — resolved at
    // load, loaded with source 'settings'. The lane falls back to the
    // prod home/cwd/trust around it (only this key is set).
    skills: { ...runtimeSkillsDeps(cliConfig) },
  };
}

// The deps `kubic tui` (and the bare interactive `kubic`) hands
// `tuiDepsWithDefaults`: the SAME projections `prodRunDeps` threads, from the
// same config load, plus the interactive-only ones. Exported for the same
// reason as `prodRunDeps`.
/** @internal */
export function prodTuiDeps(
  io: ProdRunnerIo,
  cliConfig: CliConfigResult,
): TuiDepsInput {
  const enterprisePolicy = runtimePolicy(cliConfig);
  // The session compaction projection, like `kubic run`.
  const compaction = runtimeCompactionDeps(cliConfig);
  // The system prompt file section, like `kubic run`.
  const systemPromptSection = runtimeSystemPromptSection(cliConfig);
  // The same request tuning `kubic run` threads — the
  // interactive boot resolves it against `--role` identically.
  const streamTuning = runtimeStreamTuning(cliConfig);
  return {
    out: io.out,
    // `error:` lines (unknown session, no models) are diagnostics.
    err: io.debug,
    // Same policy install as `kubic run`: the TUI
    // drives the same lane, so a config that names classes must reach
    // it here too.
    ...installedPolicyClasses(cliConfig),
    policySource: installedPolicyDeps(cliConfig).source,
    // The config `[approvals]` policy, same as `kubic run`.
    approvals: runtimeApprovalDeps(cliConfig),
    // The same journal retention projection `kubic run`
    // threads — a TUI session's journal age-prunes under config.
    journalRetention: runtimeRunDeps(cliConfig).journalRetention,
    // The same out-of-scope projection — the
    // interactive lane's baseline and sweep exclude what `kubic run`
    // excludes.
    reconcileOutOfScope: runtimeRunDeps(cliConfig).reconcileOutOfScope,
    // The same session compaction projection `kubic run`
    // threads — the interactive lane compacts under the configured
    // policy, not the lane defaults.
    ...(compaction === undefined ? {} : { compaction }),
    // The same system prompt file section — the interactive
    // lane assembles the same prompt.
    ...(systemPromptSection === undefined ? {} : { systemPromptSection }),
    // With: the SAME model projection `kubic run`
    // consumes — the cli `--model` (above `KUBIC_MODEL`/`[model]`) included.
    // Without it the TUI ignored those pins and ran the first registered
    // provider.
    model: runtimeModelPin(cliConfig),
    // Spread beside the model pin so the tuning can
    // never drift from the projection `kubic run` boots with.
    ...(streamTuning === undefined ? {} : { streamTuning }),
    // Enterprise policy: the interactive lane gates role
    // grants, model selection and its tool set identically.
    ...(enterprisePolicy === undefined
      ? {}
      : { modelPolicy: enterprisePolicy }),
    // A frozen enterprise `[model]` also binds `/model`.
    ...(runtimeModelFrozen(cliConfig) ? { modelPinFrozen: true } : {}),
    // The `[ui] theme` reference — a built-in name or a
    // JSON theme path, resolved and validated before the alt-screen opens.
    ...(cliConfig.runtime?.config.ui?.theme === undefined
      ? {}
      : { theme: cliConfig.runtime.config.ui.theme }),
    // The same per-path check gates the project models.json
    // and each ancestor skill root on the interactive lane.
    trustProject: projectTrustFor(cliConfig),
    // The first screen's version and trust row (the trust row
    // is omitted when the project has no layer).
    ...(io.version === undefined ? {} : { version: io.version() }),
    ...(cliConfig.trust?.present === true
      ? { projectTrust: cliConfig.trust.trusted ? 'loaded' : 'untrusted' }
      : {}),
    // The SAME lane projections `kubic run` consumes — the
    // interactive lane names itself and layers `--role` identically.
    ...runtimeLaneDeps(cliConfig),
    // The same settings-skills projection `kubic run`
    // threads — the interactive lane loads the config skills too.
    skills: { ...runtimeSkillsDeps(cliConfig) },
  };
}

export function sessionsRunner(io: ProdRunnerIo): ProdRunners['sessions'] {
  const { out, debug } = io;
  return (invocation, cliConfig) => {
    // `sessions prune`'s default keep-window comes from config
    // when it sets one; with none, prune demands an explicit --keep-days
    // rather than inventing a window.
    const retentionDays = sessionRetentionDays(cliConfig);
    const view = presentation(
      out,
      debug,
      invocation.command === 'list' && invocation.json === true,
    );
    return runSessionsCommand(invocation, {
      ...view,
      ...(retentionDays === undefined ? {} : { retentionDays }),
      // A prune with neither --yes nor --dry-run asks on a TTY; off a
      // TTY it stays the documented dry run.
      ...(view.interactive
        ? {
            confirm: (message: string) =>
              promptConfirm({
                message,
                interactive: true,
                nonInteractive: false,
              }),
          }
        : {}),
    });
  };
}

export function runRunner(io: ProdRunnerIo): ProdRunners['run'] {
  const { out, debug } = io;
  return (options, cliConfig) => {
    noteOverriddenModelPins(io, cliConfig);
    return runRunCommand(options, {
      ...presentation(out, debug, options.json === true),
      run: (prompt, options) =>
        runHeadlessPrompt(prompt, options, prodRunDeps(cliConfig)),
      // Live progress only when the whole run is on an
      // interactive colour terminal (stdout AND stderr) and not --json;
      // a redirected stdout keeps the plain lines scripts read.
      ...(options.json !== true &&
      isFancy(process.stdout) &&
      isFancy(process.stderr)
        ? {
            progress: () =>
              createRunProgress(process.stderr, themeFor(process.stderr), {
                cwd: process.cwd(),
                home: homedir(),
              }),
          }
        : {}),
    });
  };
}

export function tuiRunner(io: ProdRunnerIo): ProdRunners['tui'] {
  return async (options, cliConfig) => {
    noteOverriddenModelPins(io, cliConfig);
    return runTuiCommand(
      options,
      tuiDepsWithDefaults(prodTuiDeps(io, cliConfig)),
    );
  };
}

// The production runners of the setup commands: models, setup, skills,
// trust and config. `kubic doctor` is in doctor.ts.

import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { findProjectRoot } from '@kubic/host/cli';
import {
  ProjectTrustStore,
  projectTrustStorePath,
  runConfigCommand,
  runSetupCommand,
  runTrustCommand,
} from '@kubic/host/config';
import {
  assembleModels,
  FAUX_NOTICE,
  fauxProviderActive,
  runModelsCommand,
} from '@kubic/host/models';
import { selectRole } from '@kubic/host/roles';
import { runSkillsCommand } from '@kubic/host/skills';
import {
  kubicConfigLoader,
  projectModelsDeps,
  projectTrustFor,
} from '../config/load.js';
import { runtimeModelPin, runtimePolicy } from '../config/model-selection.js';
import {
  installedPolicyClasses,
  runtimeLaneDeps,
  runtimeProjectInstructions,
  runtimeSkillsDeps,
} from '../config/projections.js';
import { prodSetupDeps } from '../setup-prod.js';
import type { ProdRunnerIo, ProdRunners } from './shared.js';
import { presentation, stderrTheme } from './shared.js';

export function modelsRunner(io: ProdRunnerIo): ProdRunners['models'] {
  const { out, debug } = io;
  return async (options, cliConfig) => {
    const view = presentation(out, debug, options.json === true);
    // The store's decision gates the project
    // models.json exactly as the env opt-in does — the composition root
    // passes the one report the config load already consumed.
    const assembled = await assembleModels(process.cwd(), process.env, {
      home: cliConfig.trust.home,
      projectTrust: projectTrustFor(cliConfig),
      ...projectModelsDeps(cliConfig),
    });
    for (const note of assembled.notes) view.logger.info(note);
    if (fauxProviderActive(process.env)) view.logger.warn(FAUX_NOTICE);
    const pin = runtimeModelPin(cliConfig);
    return runModelsCommand(options, {
      ...view,
      models: assembled.models,
      providers: assembled.providers,
      defaultedWindows: assembled.defaultedWindows,
      fallbackProviders: assembled.fallbackProviders,
      // The configured pin is the default the view marks.
      ...(pin === undefined
        ? {}
        : { defaultModel: `${pin.provider}/${pin.id}` }),
    });
  };
}

// The interactive setup (provider, model, thinking, trust).
export function setupRunner(io: ProdRunnerIo): ProdRunners['setup'] {
  const { out, debug } = io;
  return async (options, cliConfig) =>
    runSetupCommand(
      options,
      await prodSetupDeps({
        out,
        err: debug,
        errTheme: stderrTheme(),
        cliConfig,
      }),
    );
}

export function skillsRunner(io: ProdRunnerIo): ProdRunners['skills'] {
  const { out, debug } = io;
  return (options, cliConfig) => {
    // The listing over the same discovery the lane boots.
    // The trust inputs mirror `kubic run`'s (the env opt-in plus the
    // per-path project check), the classes are the installed ones the
    // doctor judges, and `--role` resolves through the same `selectRole`
    // call — a refusal fails the listing closed with its named reason.
    const view = presentation(out, debug, options.json === true);
    const cwd = process.cwd();
    const rolesBridge = createNodeFileBridge(cwd);
    const enterprisePolicy = runtimePolicy(cliConfig);
    const layers = runtimeLaneDeps(cliConfig).roles?.layers;
    return runSkillsCommand(options, {
      ...view,
      base: {
        bridge: createNodeFileBridge(cwd),
        cwd,
        homeDir: cliConfig.trust.home,
        trusted:
          process.env.KUBIC_TRUST_PROJECT === '1' ||
          process.env.KUBIC_TRUST_PROJECT === 'true',
        trustProject: projectTrustFor(cliConfig),
        ...runtimeSkillsDeps(cliConfig),
        ...installedPolicyClasses(cliConfig),
      },
      resolveRole: (name: string) => {
        const selected = selectRole({
          bridge: rolesBridge,
          cwd,
          role: name,
          projectRoot: findProjectRoot(rolesBridge, cwd, cliConfig.trust.home),
          ...(layers === undefined ? {} : { layers }),
          trustProject: projectTrustFor(cliConfig),
          ...(enterprisePolicy === undefined
            ? {}
            : { toolPolicy: enterprisePolicy }),
        });
        return {
          name: selected.resolved.name,
          ...(selected.doc.skills === undefined
            ? {}
            : { skills: selected.doc.skills }),
          classes: selected.resolved.classes,
        };
      },
    });
  };
}

export function trustRunner(io: ProdRunnerIo): ProdRunners['trust'] {
  const { out, debug } = io;
  return (options, cliConfig) => {
    // Grants are recorded at the project root — the same
    // root the config load keys its trust report to — so `kubic trust`
    // from a subdirectory records a grant the loader honours. An
    // explicit path resolves to its own root; the bare form reuses the
    // load's root (it was resolved from this same cwd).
    const target = options.path ?? process.cwd();
    const root =
      options.path === undefined
        ? cliConfig.projectRoot
        : findProjectRoot(
            createNodeFileBridge(target),
            target,
            cliConfig.trust.home,
          );
    // `--list` names no directory — it reports every decision — so only a
    // grant or a revoke is re-pointed at the project root.
    return runTrustCommand(
      options.list === true || root === target
        ? options
        : { ...options, path: root },
      {
        ...presentation(out, debug, false),
        store: new ProjectTrustStore(
          projectTrustStorePath(cliConfig.trust.home),
        ),
        cwd: process.cwd(),
      },
    );
  };
}

export function configRunner(io: ProdRunnerIo): ProdRunners['config'] {
  const { out, debug } = io;
  return (options, cliConfig) =>
    // Effective configuration with the layer each value came from: human
    // lines, or --json for machines. Fails closed on a broken config instead
    // of printing defaults.
    runConfigCommand(options, {
      ...presentation(out, debug, options.json === true),
      load: kubicConfigLoader(cliConfig),
      // The AGENTS.md search the lane boot runs, from this cwd.
      instructions: () => runtimeProjectInstructions(cliConfig, process.cwd()),
    });
}

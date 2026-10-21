// The boot's last step: the lane, booted with everything the earlier steps
// resolved, and the model and thinking level it actually runs.

import type { Lane } from '@kubic/agent/lane/boot';
import { bootLane } from '@kubic/agent/lane/boot';
import { ModelSelectError } from '@kubic/agent/model-select';
import { resolveStreamOptions } from '@kubic/agent/stream-options';
import type { ExecutionEnv } from '@kubic/exec/env';
import type { RuntimeThinking } from '@kubic/host/config';
import {
  dataProtectionOf,
  hasModelPolicy,
  hasToolPolicy,
  isModelAllowed,
  isToolAllowedByEnterprise,
} from '@kubic/host/policy';
import { resolveRoleThinking } from '../config/model-selection.js';
import { toolHooksFor } from './admin-hooks.js';
import type { BootRefusal, SessionBoot } from './bootstrap.js';
import { mcpExternalTools } from './mcp.js';

// The lane's appended prompt sections: the `[agent] systemPromptFile` text
// first (the user's own instructions), the project's AGENTS.md files second,
// the skills block last (discovered context). Undefined when none is set, so
// the lane assembles its prompt unchanged — the cache-stable prefix is never
// rewritten by an empty composition.
/** @internal */
export function composePromptSections(
  systemPromptSection: string | undefined,
  instructionsBlock: string | undefined,
  skillsBlock: string | undefined,
): string[] | undefined {
  const sections = [
    ...(systemPromptSection === undefined ? [] : [systemPromptSection]),
    ...(instructionsBlock === undefined ? [] : [instructionsBlock]),
    ...(skillsBlock === undefined ? [] : [skillsBlock]),
  ];
  return sections.length === 0 ? undefined : sections;
}

// The lane's thinking request. A per-run source (cli `--thinking`, env
// `KUBIC_MODEL_THINKING`, enterprise-frozen included) is the override and
// beats the session's stored level; a file-layer source is the config
// default the stored level and the role default beat. The lane reads the
// stored level itself and clamps to the effective model.
function laneThinking(
  request: RuntimeThinking | undefined,
  role: ReturnType<typeof resolveRoleThinking>,
): Parameters<typeof bootLane>[0]['thinking'] {
  if (request === undefined && role === undefined) return undefined;
  const perRun =
    request?.source === 'cli' ||
    request?.source === 'env' ||
    request?.source === 'enterprise';
  return {
    ...(request === undefined
      ? {}
      : perRun
        ? { override: { level: request.level, source: request.source } }
        : { config: { level: request.level, source: request.source } }),
    ...(role === undefined ? {} : { role }),
  };
}

// The enterprise gates the lane installs: the tool gate drives the active
// tool set and the prompt's tools line; the model gate checks the stored
// model of a resumed session (the selection was checked at the catalog
// step), under `[policy]` and `allowed_regions` alike.
function laneGates(boot: SessionBoot): {
  toolGate?: (tool: string) => boolean;
  modelGate?: (provider: string, modelId: string) => boolean;
} {
  const policy = boot.config.modelPolicy;
  const policyGate =
    policy !== undefined && hasModelPolicy(policy)
      ? (provider: string, modelId: string): boolean =>
          isModelAllowed(policy, provider, modelId)
      : undefined;
  const regionGate = boot.regionGate;
  return {
    ...(policy !== undefined && hasToolPolicy(policy)
      ? {
          toolGate: (tool: string): boolean =>
            isToolAllowedByEnterprise(policy, tool),
        }
      : {}),
    ...(policyGate === undefined && regionGate === undefined
      ? {}
      : {
          modelGate: (provider: string, modelId: string): boolean =>
            (policyGate?.(provider, modelId) ?? true) &&
            regionGate?.(provider) === undefined,
        }),
  };
}

export async function bootSessionLane(
  boot: SessionBoot,
  env: ExecutionEnv,
): Promise<BootRefusal | undefined> {
  const { config, request, sinks } = boot;
  const installed = boot.requireInstalled();
  const model = boot.model;
  const models = boot.models;
  const session = boot.session;
  const skills = boot.skills;
  if (model === undefined || models === undefined || session === undefined) {
    throw new Error('boot steps ran out of order');
  }
  const role = boot.role;
  const policy = config.modelPolicy;
  const { toolGate, modelGate } = laneGates(boot);
  // Request options: the merged `[model]` tuning with the role layered
  // over it becomes this lane's `settings.stream`.
  const stream = resolveStreamOptions(
    config.streamTuning?.model,
    request.role === undefined
      ? undefined
      : config.streamTuning?.roles?.[request.role],
  );
  const thinking = laneThinking(
    config.thinking,
    // A matching set entry's thinking wins over the flat role default —
    // resolved against the SELECTED model.
    resolveRoleThinking(role?.resolved, model.provider, model.id),
  );
  const sections = composePromptSections(
    config.systemPromptSection,
    boot.instructions?.block,
    skills?.block,
  );
  const contributions = [...installed.contributions];
  const toolHooks = toolHooksFor(config.hooks, {
    sessionId: boot.id,
    workspace: env.cwd,
    model: `${model.provider}/${model.id}`,
    onAuditError: sinks.warn,
  });
  try {
    boot.lane = await bootLane({
      session,
      models,
      model,
      modelPolicy: boot.explicitModel ? 'selected' : 'stored',
      onModelNotice: sinks.modelNotice,
      ...(sinks.thinkingNotice === undefined
        ? {}
        : { onThinkingNotice: sinks.thinkingNotice }),
      ...(thinking === undefined ? {} : { thinking }),
      // The session id pins the boot model for the task — escalation is
      // the only path off it.
      taskId: boot.id,
      env,
      sessionId: boot.id,
      agentId: config.agentId ?? 'root',
      journal: boot.journal,
      // An untuned boot omits `stream` — the provider defaults stand.
      ...(stream === undefined ? {} : { settings: { stream } }),
      ...(request.currentTurn === undefined
        ? {}
        : { currentTurn: request.currentTurn }),
      ...(sections === undefined ? {} : { promptSections: sections }),
      // The allowlisted MCP servers' tools, each call audited.
      ...(boot.mcp.length === 0
        ? {}
        : { externalTools: mcpExternalTools(boot, env.cwd) }),
      // The advertised skills outside the cwd stay readable.
      ...(skills === undefined || skills.readRoots.length === 0
        ? {}
        : { skillReadRoots: skills.readRoots }),
      // The role document's resolved set narrows the lane (absence, not
      // approval).
      ...(role === undefined
        ? {}
        : {
            rolePrompt: role.prompt,
            ...(role.resolved.tools.length === 0
              ? {}
              : { toolAllowlist: role.resolved.tools }),
          }),
      // The explicit CLI selection narrows whatever the role granted: the
      // lane intersects it (never widens).
      ...(request.noTools === true ? { noTools: true } : {}),
      ...(request.tools === undefined
        ? {}
        : { toolSelection: [...request.tools] }),
      ...(config.compaction === undefined
        ? {}
        : { compaction: config.compaction }),
      // One policy object carrying every mechanism: the classes, the
      // always-installed interceptors, the contributions, and the tool
      // spans after policy (a blocked call never opens one).
      policy: {
        classes: installed.classes,
        interceptors: {
          ...installed.interceptors,
          // `data_policy = "redact-model"`: tool output is scanned before
          // the model reads it, and each redaction is named.
          ...(dataProtectionOf(policy) === 'redact-model'
            ? {
                redactToolOutput: (tool: string, found: number) =>
                  sinks.dlpNotice?.(
                    `data policy: ${found} secret value(s) redacted from the ${tool} tool's output before the model read it`,
                  ),
              }
            : {}),
          // The `[[hooks]]` around each call.
          ...(toolHooks === undefined ? {} : { toolHooks }),
        },
        ...(contributions.length === 0 ? {} : { contributions }),
        ...(request.spanHooks === undefined
          ? {}
          : { spanHooks: request.spanHooks }),
        // Enterprise tool gate: the same predicate drives the active tool
        // set and the prompt tools line.
        ...(toolGate === undefined ? {} : { toolAllowed: toolGate }),
        ...(modelGate === undefined ? {} : { modelAllowed: modelGate }),
      },
    });
  } catch (error) {
    // A stored session model that is not registered is the same refusal
    // as an unknown selection.
    if (error instanceof ModelSelectError) {
      return { kind: 'provider', message: error.message };
    }
    throw error;
  }
  // The boot reconciled the selection with the session's stored model and
  // level: the audit rows name what the lane reports.
  const agent = await boot.lane.conversation.agent(boot.request.context);
  const live = agent.model;
  const running =
    live === undefined
      ? (boot.lane.model as Lane['model'] | undefined)
      : { provider: live.provider, id: live.modelId };
  if (running !== undefined) {
    boot.liveModel = { provider: running.provider, id: running.id };
    boot.liveModelRef = `${running.provider}/${running.id}`;
  }
  // pi-durable defaults an unset level to `off`, the same answer
  // `/thinking` reports.
  boot.thinkingLevel = agent.thinkingLevel;
  boot.liveThinkingRef = agent.thinkingLevel ?? 'off';
  return undefined;
}

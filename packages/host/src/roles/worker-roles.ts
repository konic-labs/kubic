// Role assignment + prompt composition on the DELEGATION path (issue #104;
// §12/§12.1, §40, §71, D11). The solo path already loads roles through
// `roles-boot.ts` (issue #99); this module is the delegation-side half: it
// assigns each worker one of the five fixed roles, reads that role
// document's `## Prompt` text, and composes the worker prompt as role text
// + that worker's plan step.
//
// Built ON the live loader: `loadRoles`/`selectRole`/`rolePromptFor` are
// reused verbatim — there is no second parser and no second loader here.
// Pure and injected: the FileBridge arrives as a parameter, so tests drive
// fixtures while prod passes the real bridge.

import type { PermissionClasses } from '../../../agents/src/policy.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import type { EffectivePolicy } from '../policy/enterprise.js';
import type { RoleLayerInput } from './resolver.js';
import { loadRoles, rolePromptFor, selectRole } from './roles-boot.js';
import {
  BUILTIN_ROLE_NAMES,
  type BuiltinRoleName,
  isBuiltinRole,
  ROLE_THINKING_DEFAULTS,
} from './roles-data.js';

export interface WorkerRoleAssignment {
  agentId: string;
  /** One of the five §12 roles (D11: the manager composes, never invents). */
  role: string;
  /** The document's own `## Prompt` body — its instruction text. */
  promptText: string;
  /** The resolver's resolved tool set: what the worker lane registers. */
  tools: string[];
  /**
   * The role's resolved classes (issue #196, §40.2): the manager sends
   * these in the task resources and the child merges them with its own
   * config classes (most restrictive wins) — the worker runs under the
   * role without re-reading a worktree document.
   */
  classes: PermissionClasses;
  /**
   * The role's approval obligations (issue #196, §41.1): document +
   * layers unioned. The child challenges these tools on its triggers.
   */
  requires: string[];
  /**
   * The resolved `provider/model` pin the worker child is told, or undefined
   * when no level chose one (issue #202): the child then keeps its own
   * selection default instead of being forced onto an invented provider.
   * Precedence: explicit per-agent pin > `[roles.<r>].model` config > the
   * document's own pin > the manager's effective model.
   */
  modelRef: string | undefined;
  /**
   * The document's own budget dims (issue #198, §71), or undefined when
   * the role declares none — absent means unbounded. A copy, so the plan
   * owns the dims the spawn gate will enforce.
   */
  budget?: Record<string, number>;
  /**
   * The thinking level the worker child is told (issues #202/#225): the
   * run's explicit level (`KUBIC_MODEL_THINKING`) when set, else the
   * role's `[roles.<r>].thinking` config default, else the role's own
   * §12 default. Undefined leaves the child's `[model].thinking` in force.
   */
  thinking: string | undefined;
}

// The document budget in force for one worker (issue #198): the
// assignment's own dims, or undefined when the role declares none (the
// spawn gate then enforces nothing for this worker). The orchestrate
// budget composition calls this only after the CLI's own by-agent and
// shared specs — spawn/CLI > document.
export function roleBudgetForAgent(
  plan: WorkerRolesPlan,
  agentId: string,
): Record<string, number> | undefined {
  return plan.assignments.find((entry) => entry.agentId === agentId)?.budget;
}

export interface WorkerRolesPlan {
  assignments: WorkerRoleAssignment[];
  /** Documents that failed to resolve or carry no instructions, by name. */
  refused: Array<{ name: string; reason: string }>;
}

// The composed plan: each step's prompt is the assigned role's `## Prompt`
// text plus the step's own prompt. Steps and agents are untouched, so the
// §103 plan contract (id/step/total/prompt) and the --resume replay path
// keep working: a composed plan is still a plain ManagerPlanStep[].
export function applyRolesToPlan<T extends { agentId: string; prompt: string }>(
  assignments: readonly WorkerRoleAssignment[],
  plan: readonly T[],
): T[] {
  const byAgent = new Map(assignments.map((entry) => [entry.agentId, entry]));
  return plan.map((step) => {
    const assignment = byAgent.get(step.agentId);
    if (assignment === undefined) return { ...step };
    return {
      ...step,
      prompt: composeWorkerPrompt(assignment.promptText, step.prompt),
    };
  });
}

export function workerRoleAssignment(
  plan: WorkerRolesPlan,
  agentId: string,
): WorkerRoleAssignment | undefined {
  return plan.assignments.find((entry) => entry.agentId === agentId);
}

// §38.1/§9.2 (issue #178): the role a worker with no explicit binding runs.
// Position in the agent list is not a task — the first worker of a run is not
// a planner by virtue of being first — so the default is the role that
// produces a change. The five roles stay fixed (D11); only the default and
// the per-agent binding decide which of them a worker gets.
export const DEFAULT_WORKER_ROLE: BuiltinRoleName = 'implementer';

export interface WorkerRolesInput {
  bridge: Pick<FileBridge, 'listDir' | 'readTextFile'>;
  cwd: string;
  // Issue #229 (§35.1): the project root the repo documents resolve at.
  // Forwarded to the live loader; absent means the cwd itself.
  projectRoot?: string;
  // Issue #430 (§33, L-D27): project trust for the repo documents —
  // forwarded to the live loader; absent both means untrusted.
  trusted?: boolean;
  trustProject?: (dir: string) => boolean;
  // Issue #241 (§35): the home directory whose `.kubic/roles` the planning
  // layers under the project documents — the same roles the worker's own
  // `kubic run --role` will resolve. Absent means no global source.
  home?: string;
  agents: readonly string[];
  layers?: RoleLayerInput[];
  // §38.1 model levels (issue #202) plus the role thinking default (issue
  // #225): the manager's own effective model pin (`provider/id`) is the
  // fallback under the role's `[roles.<r>].model`, and the run's explicit
  // thinking level (`KUBIC_MODEL_THINKING`) outranks the role's
  // `[roles.<r>].thinking` config default, which outranks the role's own
  // §12 default. Both absent means the child keeps its own
  // selection/thinking defaults — never a hardcoded role provider.
  parentModel?: string;
  thinkingOverride?: string;
  // Explicit per-agent binding (issue #178): `roles` names one of the five
  // §12 roles for an agent id, `models` pins its `provider/id` — the highest
  // model level (§38.1 agent/spawn override), above `[roles.<r>].model`.
  // An id absent from `roles` takes DEFAULT_WORKER_ROLE.
  roles?: Readonly<Record<string, string>>;
  models?: Readonly<Record<string, string>>;
  // §58 enterprise policy (issue #288): each ASSIGNED role's declared tools
  // are checked against it, so the manager refuses — by name, before any
  // worktree or process exists — the assignment a worker's own
  // `kubic run --role` would refuse. Only assigned roles are judged: a
  // denied role no worker runs never refuses the run.
  toolPolicy?: EffectivePolicy;
}

// §38.1 (issue #202): the run's explicit thinking level — the documented
// `KUBIC_MODEL_THINKING` runtime override, when the operator set one. ONE
// derivation for the orchestrate run and doctor's credential posture, so the
// two can never disagree about which level is in force.
export function thinkingOverrideFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env.KUBIC_MODEL_THINKING;
  return raw === undefined || raw === '' ? undefined : raw;
}

// The §12 role a worker runs (issue #178): the caller's explicit binding for
// that agent when it gave one, else the implementer default. Deterministic —
// the same binding plus the same agent list always resolves the same role, so
// a --resume replays the stored assignment.
export function roleForAgent(
  agents: readonly string[],
  agentId: string,
  roles: Readonly<Record<string, string>> = {},
): string | undefined {
  if (!agents.includes(agentId)) return undefined;
  // OWN property only: an agent id is `[A-Za-z0-9_-]+`, so `toString`,
  // `constructor` and friends are legal ids — a plain `roles[id]` lookup
  // would return `Object.prototype`'s member and treat a FUNCTION as the
  // role (review finding, #178).
  return Object.hasOwn(roles, agentId) ? roles[agentId] : DEFAULT_WORKER_ROLE;
}

// The worker prompt: the role document's `## Prompt` text plus that
// worker's own plan step. Both halves verbatim — the role text is the
// instruction, the step is the work, and neither replaces the other.
export function composeWorkerPrompt(
  rolePromptText: string,
  stepPrompt: string,
): string {
  return `${rolePromptText}\n\n${stepPrompt}`;
}

// One assignment per agent, resolved through the live loader. Fail-closed
// per §40.3: a document that fails to resolve, or a role with no
// `## Prompt` section, is reported with its named reason and its worker is
// left unassigned — the caller refuses the run rather than composing a
// prompt from invented text. A workspace with no role documents is not a
// special case: the five §12 presets ship with the binary (issue #203), so
// every worker is assigned a role — the default implementer for an unbound
// agent (issue #178) — from the embedded documents.
export function planWorkerRoles(input: WorkerRolesInput): WorkerRolesPlan {
  // A role directory that cannot be loaded at all (an unparseable document,
  // an unreadable directory) is a §40.3 refusal too, never a thrown crash
  // mid-run: the named reason travels to the operator under the same
  // `role_refused` code as a contradiction.
  let loaded: ReturnType<typeof loadRoles>;
  try {
    loaded = loadRoles({
      bridge: input.bridge,
      cwd: input.cwd,
      ...(input.projectRoot === undefined
        ? {}
        : { projectRoot: input.projectRoot }),
      ...(input.home === undefined ? {} : { home: input.home }),
      ...(input.layers === undefined ? {} : { layers: input.layers }),
      ...(input.trusted === undefined ? {} : { trusted: input.trusted }),
      ...(input.trustProject === undefined
        ? {}
        : { trustProject: input.trustProject }),
    });
  } catch (error) {
    return {
      assignments: [],
      refused: [
        {
          name: '(documents)',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  // A document that fails to resolve is already reported by the loader; the
  // per-agent selection below reaches the same refusal. Keyed by role name
  // so one broken document is one refusal, never one per worker assigned to
  // it.
  const refusedByName = new Map<string, string>();
  for (const refusal of loaded.refused) {
    refusedByName.set(refusal.name, refusal.reason);
  }
  const assignments: WorkerRoleAssignment[] = [];
  for (const agentId of input.agents) {
    const role = roleForAgent(input.agents, agentId, input.roles);
    if (role === undefined) continue;
    // A binding outside the fixed five is refused by name (D11): the manager
    // composes from the presets, never invents a role at runtime.
    if (!isBuiltinRole(role)) {
      refusedByName.set(
        role,
        `unknown role '${role}' (not one of ${BUILTIN_ROLE_NAMES.join(', ')}): refusing spawn`,
      );
      continue;
    }
    try {
      const selected = selectRole({
        bridge: input.bridge,
        cwd: input.cwd,
        role,
        ...(input.projectRoot === undefined
          ? {}
          : { projectRoot: input.projectRoot }),
        ...(input.home === undefined ? {} : { home: input.home }),
        ...(input.layers === undefined ? {} : { layers: input.layers }),
        ...(input.trusted === undefined ? {} : { trusted: input.trusted }),
        ...(input.trustProject === undefined
          ? {}
          : { trustProject: input.trustProject }),
        ...(input.toolPolicy === undefined
          ? {}
          : { toolPolicy: input.toolPolicy }),
      });
      const promptText = rolePromptFor(selected.doc, selected.markdown);
      // Issue #225: the role's merged `[roles.<r>].thinking` config default
      // sits between the run's explicit level and the hardcoded §12
      // default — without it the config-file value the docs promise the
      // child never reaches the plan (the GAP in #225's review).
      const fallbackThinking = ROLE_THINKING_DEFAULTS[role];
      assignments.push({
        agentId,
        role,
        promptText,
        tools: [...selected.resolved.tools],
        // Issue #196 (§40.2/§41.1): the role's classes and approval
        // obligations travel in the task resources — the child merges
        // the classes with its own config, most restrictive wins.
        classes: { ...selected.resolved.classes },
        requires: [...selected.resolved.requires],
        // §38.1 (issue #202/#178): the explicit per-agent pin, then the
        // role's own config pin, then the manager's model — never the role
        // NAME and never a hardcoded provider.
        modelRef:
          (input.models !== undefined && Object.hasOwn(input.models, agentId)
            ? input.models[agentId]
            : undefined) ??
          selected.resolved.model ??
          input.parentModel,
        thinking:
          input.thinkingOverride ??
          selected.resolved.thinking ??
          fallbackThinking,
        // Issue #198 (§71): the document's own budget dims ride the
        // assignment, so the spawn gate can enforce them when no
        // spawn/CLI budget outranks them. Absent stays absent.
        ...(selected.resolved.budget === undefined
          ? {}
          : { budget: { ...selected.resolved.budget } }),
      });
    } catch (error) {
      refusedByName.set(
        role,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return {
    assignments,
    refused: [...refusedByName.entries()].map(([name, reason]) => ({
      name,
      reason,
    })),
  };
}

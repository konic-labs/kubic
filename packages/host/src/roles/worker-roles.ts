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
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import type { EffectivePolicy } from '../policy/enterprise.js';
import type { RoleLayerInput } from './resolver.js';
import {
  loadRoles,
  roleDocPath,
  rolePromptFor,
  selectRole,
} from './roles-boot.js';
import {
  BUILTIN_ROLE_NAMES,
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
   * The resolved `provider/model` pin the worker child is told, or undefined
   * when no level chose one (issue #202): the child then keeps its own
   * selection default instead of being forced onto an invented provider.
   * Precedence: `[roles.<r>].model` config > the manager's effective model.
   */
  modelRef: string | undefined;
  /**
   * The thinking level the worker child is told (issue #202): the run's
   * explicit level (`KUBIC_MODEL_THINKING`) when set, else the role's own
   * §12 default. Undefined leaves the child's `[model].thinking` in force.
   */
  thinking: string | undefined;
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

export interface WorkerRolesInput {
  bridge: Pick<FileBridge, 'listDir' | 'readTextFile'>;
  cwd: string;
  agents: readonly string[];
  layers?: RoleLayerInput[];
  // §38.1 model levels (issue #202): the manager's own effective model pin
  // (`provider/id`) is the fallback under the role's `[roles.<r>].model`,
  // and the run's explicit thinking level (`KUBIC_MODEL_THINKING`) outranks
  // the role's own thinking default. Both absent means the child keeps its
  // own selection/thinking defaults — never a hardcoded role provider.
  parentModel?: string;
  thinkingOverride?: string;
  // §58 enterprise policy (issue #288): each ASSIGNED role's declared tools
  // are checked against it, so the manager refuses — by name, before any
  // worktree or process exists — the assignment a worker's own
  // `kubic run --role` would refuse. Only assigned roles are judged: a
  // denied role no worker runs never refuses the run.
  toolPolicy?: EffectivePolicy;
}

// The §12 roles in the order the delegation path assigns them: the first
// worker plans (it decomposes without mutating anything), the second
// implements. Deterministic from the agent order alone — the run state
// persists that order, so a --resume assigns each worker the same role.
export function roleForAgent(
  agents: readonly string[],
  agentId: string,
): string | undefined {
  const index = agents.indexOf(agentId);
  if (index === -1) return undefined;
  return BUILTIN_ROLE_NAMES[index % BUILTIN_ROLE_NAMES.length];
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
// prompt from invented text. A workspace with no role documents at all is
// the normal case (the solo default is unaffected): no assignment, no
// refusal, and the plan prompt stands.
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
      ...(input.layers === undefined ? {} : { layers: input.layers }),
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
  if (loaded.docs.length === 0) return { assignments: [], refused: [] };
  const assignments: WorkerRoleAssignment[] = [];
  for (const agentId of input.agents) {
    const role = roleForAgent(input.agents, agentId);
    if (role === undefined) continue;
    try {
      const selected = selectRole({
        bridge: input.bridge,
        cwd: input.cwd,
        role,
        ...(input.layers === undefined ? {} : { layers: input.layers }),
        ...(input.toolPolicy === undefined
          ? {}
          : { toolPolicy: input.toolPolicy }),
      });
      const promptText = rolePromptFor(
        selected.doc,
        input.bridge.readTextFile(roleDocPath(input.cwd, role)),
      );
      const fallbackThinking = isBuiltinRole(role)
        ? ROLE_THINKING_DEFAULTS[role]
        : undefined;
      assignments.push({
        agentId,
        role,
        promptText,
        tools: [...selected.resolved.tools],
        // §38.1 (issue #202): the role's own config pin, then the manager's
        // model — never the role NAME (a non-built-in role resolves no
        // model of its own) and never a hardcoded provider.
        modelRef: selected.resolved.model ?? input.parentModel,
        thinking: input.thinkingOverride ?? fallbackThinking,
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

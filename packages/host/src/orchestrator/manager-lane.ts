// Manager lane slice 4 (issue #413; §9.2, §40): the model-driven manager
// as a real pi-durable conversation. `bootManagerLane()` mirrors
// `bootSoloLane` (worker/lane/solo.ts) — `Harness.open` over the adopted
// session storage, the root conversation, ONE `kubic.manager` extension —
// but the registry carries only the manager allowlist, and the system
// prompt advertises exactly that set (§40.3, the same one-set rule as the
// solo `tools:` line).
//
// Step 1 of the #204 split: every §9.2 tool is a fail-closed stub — the
// real adapters land in #414 (spawn/wait/collect), #415
// (inspect/cancel/send), #416 (workspace/git tools) and #417 (ask_user).
// Nothing routes a live run here yet: faux, `--resume` and the `--agents`
// template path keep `buildManagerPlan` end-to-end (byte-stable), so the
// lane is booted by tests and by later steps only.
import type { SessionHandle } from '../../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type Conversation,
  type createModels,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type Model,
  type Registry,
  section,
  type ToolRegistration,
  Type,
} from '../../../worker/src/pi-boundary.js';
import {
  assertManagerToolset,
  MANAGER_ALLOWLIST,
  type ManagerToolName,
  ManagerToolNotWiredError,
} from './manager.js';

export const MANAGER_EXTENSION_NAME = 'kubic.manager';

// The stable key of the one prompt section the manager extension installs
// (section keys are `[a-z][a-z0-9_-]*` — no dots, unlike extension names).
export const MANAGER_PROMPT_SECTION = 'manager';

// Step 2–5 own the real adapters (see the module header): the stub refuses
// by name so a model that reaches one learns exactly which tool is unwired.
// The descriptions are the shipped §9.2 summaries, so the prompt advertises
// the real toolset from step 1 — only the bodies are stubs.
const MANAGER_STUB_DESCRIPTIONS: Record<ManagerToolName, string> = {
  spawn_agent: 'Spawn a role-typed worker to perform a task.',
  send_to_agent: 'Send a follow-up prompt to a worker.',
  wait_for_agent: 'Wait for a worker to settle.',
  cancel_agent: 'Cancel a running worker; the run continues.',
  inspect_agent: 'Read a worker row and state, never its transcript.',
  collect_result: 'Collect a settled worker result (summary only).',
  workspace_diff: 'Show a worker-produced diff for review.',
  workspace_apply: 'Apply a reviewed worker-produced diff.',
  workspace_merge: 'Merge a reviewed worker-produced diff.',
  review_verdict: 'Record the reviewer verdict a merge executes.',
  ask_user: 'Ask the operator through the approval seat.',
  git_status: 'Read-only git status of the repo.',
  git_diff: 'Read-only git diff of the repo.',
  git_log: 'Read-only git log of the repo.',
};

function stubManagerTool(name: ManagerToolName): ToolRegistration {
  return defineTool({
    name,
    description: MANAGER_STUB_DESCRIPTIONS[name],
    parameters: Type.Object({}),
    execute: async () => {
      throw new ManagerToolNotWiredError(name);
    },
  });
}

/** The 14 allowlist tools in allowlist order — stubs until steps 2–5. */
export function managerToolStubs(): ToolRegistration[] {
  return MANAGER_ALLOWLIST.map((name) => stubManagerTool(name));
}

/**
 * The manager system prompt over exactly the offered set: the `tools:` line
 * names what the conversation offers, nothing more (§40.3). Pure, so tests
 * pin the advertisement without booting a lane.
 */
export function assembleManagerPrompt(toolNames: readonly string[]): string {
  return [
    'You are the Kubic orchestrator manager: you never execute or author —',
    'you decompose the objective, spawn role-typed workers, read their',
    'summaries, and merge their diffs.',
    // The §70 review loop (issue #188): the sequencing RULE the manager
    // follows — a tester whose tests fail routes a debugger (with the
    // failing tests and the diff ref, which later workers inherit),
    // then the tester re-runs. Bounded: past --max-attempts debugger
    // settlements the next debugger escalates once, then further
    // debugger spawns refuse and the run fails. Record each settled
    // worker's verdict with review_verdict, then workspace_merge
    // executes it: accept merges, request-changes discards the diff.
    'review loop: a tester whose tests fail routes debugger (with the failing tests and the diff ref), then the tester re-runs — bounded, one escalation, then the run fails; review_verdict each settled worker, workspace_merge executes the verdict.',
    `tools: ${[...toolNames].join(', ')}`,
  ].join('\n');
}

export interface ManagerBootOptions {
  session: SessionHandle;
  models: ReturnType<typeof createModels>;
  model: Model<string>;
  sessionId: string;
  /** The repo root the manager reads (the prompt's working directory). */
  cwd: string;
  context?: Context;
  /**
   * Override the tool set (the gate's test seam): production always passes
   * the allowlist stubs, so a drifted set refuses to boot below.
   */
  tools?: readonly ToolRegistration[];
}

export interface ManagerLaneHandle {
  harness: Harness;
  conversation: Conversation;
  /** The per-process registry carrying only the `kubic.manager` extension. */
  registry: Registry;
  model: Model<string>;
  sessionId: string;
  // Shuts the harness down (and with it the session's storage). Releasing
  // the session handle — lock included — stays the caller's job, as with
  // the solo lane.
  close(context: Context): Promise<void>;
}

/**
 * Boot the manager lane: gate the toolset, open the harness over the
 * adopted manager-session storage, and configure the root conversation
 * with the selected model and the manager prompt. A drifted toolset
 * refuses to START (`ManagerToolsetError`, naming the extra/missing
 * names) rather than running with an exec tool registered.
 */
export async function bootManagerLane(
  options: ManagerBootOptions,
): Promise<ManagerLaneHandle> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const tools = options.tools ?? managerToolStubs();
  // The gate runs BEFORE anything opens: a drifted lane never owns a
  // storage, never boots a conversation.
  assertManagerToolset(tools.map((tool) => tool.name));
  const toolNames = tools.map((tool) => tool.name);
  const promptText = assembleManagerPrompt(toolNames);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: MANAGER_EXTENSION_NAME,
      tools: [...tools],
      sections: [
        section(MANAGER_PROMPT_SECTION, () => promptText, { tag: false }),
      ],
    }),
  );
  // Adopt, never take `storage` directly (D8.1, as in bootSoloLane): the
  // handle must know a harness owns the storage, or its `release()` would
  // close the storage under the live harness.
  const harness = await Harness.open(
    options.session.adopt(),
    {
      models: options.models,
      registry,
      // One tool at a time, as on the solo lane: spawn admission must
      // follow call order, so a queued `spawn_agent` never jumps the cap
      // ahead of an earlier call (issue #414).
      settings: {
        toolExecution: 'sequential',
        // Fail fast on provider errors (issue #431, L-D34): no durable
        // generation retries inside the manager lane — a refused
        // connection or a dead endpoint surfaces on the first attempt
        // as `unanswered`, which the router refuses by name
        // (`lane_provider_unreachable`) instead of burning minutes in
        // hidden backoff. Transient blips fail the run; the operator
        // retries with `--resume`, which replays the stored transcript.
        retry: { enabled: false },
      },
    },
    context,
  );
  const conversation = await harness.root(context);
  if (conversation === undefined) {
    throw new Error(`manager session ${options.session.id} has no root`);
  }
  await conversation.configure(
    {
      model: { provider: options.model.provider, modelId: options.model.id },
    },
    context,
  );
  return {
    harness,
    conversation,
    registry,
    model: options.model,
    sessionId: options.sessionId,
    close: (closeContext) => harness.close(closeContext),
  };
}

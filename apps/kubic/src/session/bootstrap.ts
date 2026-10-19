// The session bootstrap `kubic run` and `kubic tui` share: open or attach the
// session, resolve the role, assemble and select the model, install the
// approval policy, capture the journal baseline, boot the skills and the lane
// — in one order, with one set of refusals — and tear it all down again.
// Each step's work is its own module (role, catalog, approval-policy,
// journal, lane); SessionBoot keeps the order, the state the steps share and
// the teardown.
//
// The two front ends differ only where the product says they do, and each
// difference is an explicit input here: the session's recorded mode, the
// approval seat, where notices go, the run's tool spans and the TUI's turn
// counter. Pending work, the turn itself, progress output and the TUI's
// interactive switches stay with each front end.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Lane, LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type {
  SessionHandle,
  SessionStore,
} from '@kubic/agent/lane/session-store';
import {
  attachSession,
  createSession,
  openSessionStore,
  SESSION_ID_PATTERN,
} from '@kubic/agent/lane/session-store';
import type { ModelSelection, selectModel } from '@kubic/agent/model-select';
import { OPERATIONS } from '@kubic/agent/ops/registry';
import type { PermissionClasses, RunMode } from '@kubic/agent/permissions';
import {
  checkAgreement,
  DEFAULT_PERMISSIONS,
  validateClasses,
} from '@kubic/agent/permissions';
import type {
  Context,
  HookRegistration,
  MutableModels,
} from '@kubic/agent/pi-boundary';
import type { StreamTuningTables } from '@kubic/agent/stream-options';
import type { ExecutionEnv } from '@kubic/exec/env';
import { NodeExecutionEnv } from '@kubic/exec/env';
import type { FileBridge } from '@kubic/exec/file-bridge';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type {
  FileJournalStore,
  JournalRetention,
  RunReconciliation,
} from '@kubic/exec/journal';
import type {
  ApprovalConfig,
  InstalledPolicy,
  installPolicy,
} from '@kubic/host/approvals';
import type { RuntimeThinking } from '@kubic/host/config';
import type { AssembledModels } from '@kubic/host/models';
import type { EffectivePolicy } from '@kubic/host/policy';
import type { ResolvedRole, RoleLayerInput } from '@kubic/host/roles';
import { redactBridgeWrites } from '@kubic/host/secret-refs';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { bootSkills } from '@kubic/host/skills';
import { installBootPolicy } from './approval-policy.js';
import { assembleBootCatalog } from './catalog.js';
import { beginBootJournal, probeBootOverlap } from './journal.js';
import { bootSessionLane } from './lane.js';
import { resolveBootRole } from './role.js';

// Why a boot stopped before the lane ran. Each front end maps these to its
// own output: an exit code and stderr for `kubic run`, an error the TUI
// command prints for `kubic tui`.
export type BootRefusal =
  // A bad argument, found before any session exists (`kubic run` exit 2).
  | { kind: 'usage'; message: string }
  // The session could not be created or attached (its own terminus).
  | { kind: 'store'; error: unknown }
  // An interrupt arrived while the boot was running.
  | { kind: 'cancelled' }
  // A refused role document (with the error that refused it) or a refused
  // skill invocation.
  | { kind: 'failed'; message: string; cause?: unknown }
  // No usable model: a refused selection or provider override (exit 6).
  | { kind: 'provider'; message: string };

// The configuration projections a boot consumes — the same for both front
// ends, since both read the one config load.
export interface SessionBootConfig {
  sessionsRoot?: string;
  env?: ExecutionEnv;
  // Config-sourced permission classes. Absent means DEFAULT_PERMISSIONS.
  classes?: PermissionClasses;
  // Where the classes came from ('default' when nothing configured them).
  policySource?: 'config' | 'default';
  // The config `[approvals]` policy. Absent means the documented defaults.
  approvals?: ApprovalConfig;
  // An installed policy to use instead of the shipped install (tests).
  policy?: InstalledPolicy;
  // A model catalog to use instead of the assembled one (tests).
  models?: MutableModels;
  // Where models.json is read from. Absent means this process's cwd.
  modelsCwd?: string;
  // The runtime model pin (cli `--model` > `KUBIC_MODEL` > `[model]`).
  model?: ModelSelection;
  streamTuning?: StreamTuningTables;
  thinking?: RuntimeThinking;
  compaction?: LaneCompactionOptions;
  // The lane's agent id (`[agent].name`). Absent means 'root'.
  agentId?: string;
  journalRetention?: JournalRetention;
  reconcileOutOfScope?: readonly string[];
  // [agent] systemPromptFile contents, composed ahead of the skills block.
  systemPromptSection?: string;
  // Enterprise policy: gates the role grants, the tool set and the model.
  modelPolicy?: EffectivePolicy;
  // The per-path trust check for the project models.json and skills.
  trustProject?: (path: string) => boolean;
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    settingsSkills?: readonly string[];
  };
  roles?: {
    cwd?: string;
    layers?: RoleLayerInput[];
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    homeDir?: string;
  };
}

// What this invocation asks for, and what differs between the front ends.
export interface SessionBootRequest {
  // Names the session's audit rows and the base-revision probe.
  command: 'run' | 'tui';
  context: Context;
  // Attach this session; absent creates a new one.
  sessionId?: string;
  // Recorded on a session this boot creates. Absent records none.
  sessionMode?: RunMode;
  role?: string;
  tools?: readonly string[];
  noTools?: boolean;
  noSkills?: boolean;
  cliSkills?: readonly string[];
  dangerouslySkipApprovals?: boolean;
  // The approval seat. Absent means the no-surface refusal.
  answer?: Parameters<typeof installPolicy>[0]['answer'];
  // Tool spans installed after the policy (`kubic run`).
  spanHooks?: () => HookRegistration[];
  // The turn a tool call belongs to (`kubic tui`).
  currentTurn?: () => number | undefined;
  // Checked before each expensive step: true stops the boot.
  cancelled?: () => boolean;
  // Called once the policy is installed, before anything else boots.
  onPolicyInstalled?: (boot: SessionBoot) => void;
  // Called once the skills are booted, before the lane: a refusal stops the
  // boot there (`kubic run --invoke-skill` naming an unknown skill).
  onSkillsBooted?: (boot: SessionBoot) => BootRefusal | undefined;
}

// Where a boot's lines go.
export interface SessionBootSinks {
  // Diagnostics: role, reconcile, overlap and skill-load receipts.
  debug?: (line: string) => void;
  // Warnings the user must see: a refused models.json.
  warn: (line: string) => void;
  // The faux testing provider is answering. Absent when the front end names
  // it itself (the TUI footer does).
  fauxNotice?: (line: string) => void;
  // A model switched (or kept) at boot, and a clamped thinking level.
  modelNotice: (line: string) => void;
  thinkingNotice?: (line: string) => void;
  // An unresolvable explicit --skill.
  skillsWarn: (line: string) => void;
  skillsLog: (line: string) => void;
}

export interface BootRole {
  resolved: ResolvedRole;
  prompt: string;
  docSkills: string[] | undefined;
}

// The tool selection is validated before anything boots: mutual exclusion,
// unknown names and the agreement with the permission classes all refuse
// rather than silently narrowing the run.
function toolSelectionRefusal(
  tools: readonly string[] | undefined,
  noTools: boolean,
  classes: PermissionClasses | undefined,
): string | undefined {
  if (tools !== undefined && noTools) {
    return '--tools and --no-tools are mutually exclusive';
  }
  if (tools === undefined) return undefined;
  const known = Object.keys(OPERATIONS).sort();
  const unknown = tools.find((tool) => !known.includes(tool));
  if (unknown !== undefined) {
    return `unknown tool ${JSON.stringify(unknown)} (known tools: ${known.join(', ')})`;
  }
  const agreement = checkAgreement(
    validateClasses({ ...(classes ?? DEFAULT_PERMISSIONS) }),
    [...tools],
  );
  return agreement.agree ? undefined : agreement.reason;
}

// One session boot. `validate`, `open` and `boot` run in that order; each
// returns a refusal or undefined. What the boot has built so far stays on the
// instance, so `teardown` can release it whichever step stopped.
export class SessionBoot {
  readonly request: SessionBootRequest;
  readonly config: SessionBootConfig;
  readonly sinks: SessionBootSinks;
  readonly root: string;
  // Every session write goes through this bridge, so it is the choke point
  // for scrubbing the live provider keys out of the session JSONL and the
  // span artifact: a provider echoing a rejected key in its error body must
  // not persist it.
  readonly bridge: FileBridge;
  store: SessionStore | undefined;
  session: SessionHandle | undefined;
  role: BootRole | undefined;
  models: MutableModels | undefined;
  // The assembly receipt (providers, their key sources, the usable set).
  // Absent when the catalog was injected.
  assembled: AssembledModels | undefined;
  model: ReturnType<typeof selectModel> | undefined;
  // True when a pin selected the model: a resumed session whose stored
  // model differs switches to it. The default pick never switches.
  explicitModel = false;
  env: ExecutionEnv | undefined;
  installed: InstalledPolicy | undefined;
  fullAccessWarning: string | undefined;
  // The base revision the run started from (`none` outside git).
  base: string | undefined;
  journal: FileJournalStore | undefined;
  reconciliation: RunReconciliation | undefined;
  skills: ReturnType<typeof bootSkills> | undefined;
  lane: Lane | undefined;
  // The model the booted lane runs.
  liveModel: { provider: string; id: string } | undefined;
  // The `provider/id` and thinking level the audit rows name. Seeded with
  // the selection and re-pointed at what the lane reports once the boot has
  // applied the stored-model rule — the policy is installed before the lane
  // exists, so it reads these at record time instead of freezing the
  // pre-boot pick. A front end that switches the model moves them too.
  liveModelRef = '';
  liveThinkingRef: string | undefined;
  // The thinking level the lane booted with, as committed (post-clamp);
  // undefined when the lane committed none.
  thinkingLevel: string | undefined;
  // Every provider key the request-time resolver has handed out so far.
  liveSecrets: () => string[] = () => [];
  private tornDown = false;

  constructor(
    request: SessionBootRequest,
    config: SessionBootConfig,
    sinks: SessionBootSinks,
  ) {
    this.request = request;
    this.config = config;
    this.sinks = sinks;
    this.root = config.sessionsRoot ?? defaultSessionsRoot();
    this.bridge = redactBridgeWrites(createNodeFileBridge(this.root), () =>
      this.liveSecrets(),
    );
  }

  get id(): string {
    if (this.session === undefined) throw new Error('session not open');
    return this.session.id;
  }

  // Refusals that need no session: a path-unsafe session id (defence in
  // depth — the CLI checks it too, but a direct caller skips the CLI) and a
  // contradictory tool selection.
  validate(): BootRefusal | undefined {
    return this.validateSessionId() ?? this.validateTools();
  }

  validateSessionId(): BootRefusal | undefined {
    const { sessionId } = this.request;
    if (sessionId === undefined || SESSION_ID_PATTERN.test(sessionId)) {
      return undefined;
    }
    return {
      kind: 'usage',
      message: `invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    };
  }

  validateTools(): BootRefusal | undefined {
    const { tools, noTools } = this.request;
    const tool = toolSelectionRefusal(
      tools,
      noTools === true,
      this.config.classes,
    );
    return tool === undefined ? undefined : { kind: 'usage', message: tool };
  }

  async open(): Promise<BootRefusal | undefined> {
    const { context, sessionId, sessionMode } = this.request;
    this.store = openSessionStore(this.root, this.bridge);
    try {
      this.session =
        sessionId === undefined
          ? await createSession(
              this.store,
              {
                cwd: this.config.env?.cwd ?? process.cwd(),
                ...(sessionMode === undefined ? {} : { mode: sessionMode }),
              },
              context,
            )
          : await attachSession(this.store, sessionId, context);
    } catch (error) {
      return { kind: 'store', error };
    }
    // The [session] debug line names the session.
    this.sinks.debug?.(`[session] id=${this.session.id}`);
    return undefined;
  }

  // Everything from the role to the booted lane, in this order: the role
  // first (its model pin is a selection input), then the models and the
  // selection, the policy (before the lane boots), the journal baseline,
  // the skills, and the lane.
  async boot(): Promise<BootRefusal | undefined> {
    // Private like the session around it: the journal holds file content.
    this.bridge.createDir(join(this.id, 'journal'), true, 0o700);
    if (this.request.cancelled?.() === true) return { kind: 'cancelled' };
    const role = resolveBootRole(this);
    if (role !== undefined && 'kind' in role) return role;
    this.role = role;
    const catalog = await assembleBootCatalog(this);
    if (catalog !== undefined) return catalog;
    const env = this.config.env ?? new NodeExecutionEnv(process.cwd());
    this.env = env;
    await installBootPolicy(this, env);
    this.request.onPolicyInstalled?.(this);
    beginBootJournal(this, env);
    await probeBootOverlap(this, env);
    this.bootRunSkills();
    const skills = this.request.onSkillsBooted?.(this);
    if (skills !== undefined) return skills;
    if (this.request.cancelled?.() === true) return { kind: 'cancelled' };
    return bootSessionLane(this, env);
  }

  // Skills discovery: the project roots stay gated behind trust, and the
  // model-visible block is appended to the system prompt. A loader refusal
  // is never fatal (skills are context, never a gate).
  private bootRunSkills(): void {
    const { config, request, sinks } = this;
    const trustProject = config.trustProject ?? config.skills?.trustProject;
    const role = this.role;
    this.skills = bootSkills({
      bridge: this.bridge,
      cwd: config.skills?.cwd ?? process.cwd(),
      homeDir: config.skills?.homeDir ?? homedir(),
      trusted:
        config.skills?.trusted ??
        (process.env.KUBIC_TRUST_PROJECT === '1' ||
          process.env.KUBIC_TRUST_PROJECT === 'true'),
      ...(trustProject === undefined ? {} : { trustProject }),
      ...(request.noSkills === undefined ? {} : { noSkills: request.noSkills }),
      ...(request.cliSkills === undefined
        ? {}
        : { cliSkills: [...request.cliSkills] }),
      ...(config.skills?.settingsSkills === undefined
        ? {}
        : { settingsSkills: [...config.skills.settingsSkills] }),
      // The injected set depends on the resolved role and the installed
      // classes.
      ...(role === undefined ? {} : { role: role.resolved.name }),
      ...(role?.docSkills === undefined ? {} : { roleSkills: role.docSkills }),
      classes: this.requireInstalled().classes,
      warn: sinks.skillsWarn,
      log: sinks.skillsLog,
    });
  }

  requireInstalled(): InstalledPolicy {
    if (this.installed === undefined) {
      throw new Error('boot steps ran out of order');
    }
    return this.installed;
  }

  // Release everything the boot built, whichever step it stopped at:
  // the end-of-run sweep, the policy's posture check, the lane, then the
  // session lock. `beforeClose` runs while the lane and session are still
  // open (the run reads its transcript there). Each step is best-effort —
  // a failure never masks the caller's result — and a second call does
  // nothing.
  async teardown(
    options: {
      beforeClose?: () => Promise<void> | void;
      // Bound the lane close (an abandoned turn may hold a stuck
      // invocation).
      closeBoundMs?: number;
    } = {},
  ): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    const { context } = this.request;
    // The sweep runs after the last turn and before the session closes, so
    // a close failure cannot skip it, and it never changes the result.
    try {
      this.reconciliation?.sweep();
    } catch (error) {
      try {
        this.sinks.debug?.(
          `reconcile: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // A throwing debug sink must not mask the result either.
      }
    }
    // A posture.json written after the last ask is restored to the boot
    // posture (and recorded) before the session closes.
    try {
      this.installed?.settle?.();
    } catch {
      // Best-effort.
    }
    try {
      await options.beforeClose?.();
    } catch {
      // Best-effort.
    }
    // The harness owns the storage it adopted; closing it first means the
    // handle's release only gives the lock back.
    try {
      if (this.lane !== undefined) {
        const closing = this.lane.close(context);
        if (options.closeBoundMs === undefined) await closing;
        else await settledWithin(closing, options.closeBoundMs);
      }
    } catch {
      // Best-effort.
    }
    try {
      await this.session?.release(context);
    } catch {
      // Best-effort.
    }
  }
}

// Waits for `work` for at most `ms`; undefined when the bound elapses. The
// promise is observed either way, so a late rejection is never unhandled.
async function settledWithin<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work.catch(() => undefined), bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

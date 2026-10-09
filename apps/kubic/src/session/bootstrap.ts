// The session bootstrap `kubic run` and `kubic tui` share: open or attach the
// session, resolve the role, assemble and select the model, install the
// approval policy, capture the journal baseline, boot the skills and the lane
// — in one order, with one set of refusals — and tear it all down again.
//
// The two front ends differ only where the product says they do, and each
// difference is an explicit input here: the session's recorded mode, the
// approval seat, where notices go, the run's tool spans and the TUI's turn
// counter. Pending work, the turn itself, progress output and the TUI's
// interactive switches stay with each front end.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  bootLane,
  type Lane,
  type LaneCompactionOptions,
} from '@kubic/agent/lane/boot';
import {
  attachSession,
  createSession,
  openSessionStore,
  SESSION_ID_PATTERN,
  type SessionHandle,
  type SessionStore,
  sessionsTouchingWorkspace,
} from '@kubic/agent/lane/session-store';
import {
  ModelSelectError,
  type ModelSelection,
  type selectModel,
} from '@kubic/agent/model-select';
import { OPERATIONS } from '@kubic/agent/ops/registry';
import {
  checkAgreement,
  DEFAULT_PERMISSIONS,
  type PermissionClasses,
  type RunMode,
  validateClasses,
} from '@kubic/agent/permissions';
import type {
  Context,
  HookRegistration,
  MutableModels,
} from '@kubic/agent/pi-boundary';
import {
  resolveStreamOptions,
  type StreamTuningTables,
} from '@kubic/agent/stream-options';
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import type { ExecutionEnv } from '@kubic/exec/env';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge, type FileBridge } from '@kubic/exec/file-bridge';
import {
  beginReconciliation,
  FileJournalStore,
  type JournalRetention,
  type RunReconciliation,
} from '@kubic/exec/journal';
import { createSecretCommandRunner } from '@kubic/exec/secret-runner';
import {
  type ApprovalConfig,
  enableSessionFullAccess,
  type InstalledPolicy,
  installPolicy,
} from '@kubic/host/approvals';
import {
  createLedgerModelKeyResolver,
  resolveRunBaseRevision,
} from '@kubic/host/audit';
import { findProjectRoot } from '@kubic/host/cli';
import type { RuntimeThinking } from '@kubic/host/config';
import {
  type AssembledModels,
  assembleModels,
  FAUX_NOTICE,
  invalidProviderMessage,
  providerOverrideFromEnv,
} from '@kubic/host/models';
import {
  type EffectivePolicy,
  hasModelPolicy,
  hasToolPolicy,
  isModelAllowed,
  isToolAllowedByEnterprise,
} from '@kubic/host/policy';
import type { ResolvedRole, RoleLayerInput } from '@kubic/host/roles';
import {
  effectiveRoleClasses,
  rolePromptFor,
  selectRole,
} from '@kubic/host/roles';
import { redactBridgeWrites } from '@kubic/host/secret-refs';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { bootSkills } from '@kubic/host/skills';
import {
  resolveRoleThinking,
  roleModelScope,
  selectBootModel,
} from '../config/model-selection.js';
import { hasExplicitModelSelection } from '../model-projection.js';

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

interface BootRole {
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

// The lane's appended prompt sections: the `[agent] systemPromptFile` text
// first (the user's own instructions), the skills block second (discovered
// context). Undefined when neither is set, so the lane assembles its prompt
// unchanged — the cache-stable prefix is never rewritten by an empty
// composition.
export function composePromptSections(
  systemPromptSection: string | undefined,
  skillsBlock: string | undefined,
): string[] | undefined {
  const sections = [
    ...(systemPromptSection === undefined ? [] : [systemPromptSection]),
    ...(skillsBlock === undefined ? [] : [skillsBlock]),
  ];
  return sections.length === 0 ? undefined : sections;
}

// The provider ids and model ids a catalog names: the words a live key value
// must not be scrubbed out of.
function catalogIdentity(models: MutableModels): string[] {
  return models
    .getProviders()
    .flatMap((provider) => [
      provider.id,
      ...models.getModels(provider.id).map((model) => model.id),
    ]);
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
    this.bridge.createDir(join(this.id, 'journal'));
    if (this.request.cancelled?.() === true) return { kind: 'cancelled' };
    const role = this.resolveRole();
    if (role !== undefined && 'kind' in role) return role;
    this.role = role;
    const catalog = await this.assembleCatalog();
    if (catalog !== undefined) return catalog;
    const env = this.config.env ?? new NodeExecutionEnv(process.cwd());
    this.env = env;
    await this.installApprovalPolicy(env);
    this.request.onPolicyInstalled?.(this);
    this.beginJournal(env);
    await this.probeOverlap(env);
    this.bootRunSkills();
    const skills = this.request.onSkillsBooted?.(this);
    if (skills !== undefined) return skills;
    if (this.request.cancelled?.() === true) return { kind: 'cancelled' };
    return this.bootRunLane(env);
  }

  // `--role` loads the role document and derives the prompt text, the tool
  // allowlist and the model default from it. The refusals are fail-closed
  // with a named reason: an unknown role, a contradictory document, a
  // document with no instructions, and a parse failure. An absent --role
  // leaves the lane boot unchanged.
  private resolveRole(): BootRole | BootRefusal | undefined {
    const { role } = this.request;
    const policy = this.config.modelPolicy;
    if (role === undefined) {
      // The stock run resolves no role document — the [policy] line still
      // names the default role it runs as.
      this.sinks.debug?.(`[policy] role=${DEFAULT_RUN_ROLE} (default)`);
      return undefined;
    }
    const roles = this.config.roles;
    const rolesCwd = roles?.cwd ?? process.cwd();
    const rolesBridge = createNodeFileBridge(rolesCwd);
    try {
      const selected = selectRole({
        bridge: rolesBridge,
        cwd: rolesCwd,
        role,
        // Role documents resolve at the project root, so `--role` from a
        // subdirectory finds `<root>/.kubic/roles/*.md`.
        projectRoot: findProjectRoot(rolesBridge, rolesCwd, homedir()),
        ...(roles?.layers === undefined ? {} : { layers: roles.layers }),
        // An untrusted root's documents are withheld — `--role` naming one
        // refuses with the trust message.
        ...(roles?.trusted === undefined ? {} : { trusted: roles.trusted }),
        ...(roles?.trustProject === undefined
          ? {}
          : { trustProject: roles.trustProject }),
        // The global `~/.kubic/roles` layer under the project documents.
        ...(roles?.homeDir === undefined ? {} : { home: roles.homeDir }),
        // A role document declaring a denied tool is refused here, by name,
        // before the lane boots.
        ...(policy === undefined ? {} : { toolPolicy: policy }),
      });
      // The prompt comes from the winning document: a repo override's text,
      // or the preset embedded in the binary.
      const prompt = rolePromptFor(selected.doc, selected.markdown);
      this.sinks.debug?.(
        `[policy] role=${selected.resolved.name} tools=${selected.resolved.tools.join(',')}`,
      );
      return {
        resolved: selected.resolved,
        prompt,
        docSkills: selected.doc.skills,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'failed', message, cause: error };
    }
  }

  // The model catalog and the boot model. Provider keys resolve per request,
  // and each use lands in the ledger of the run's workspace.
  private async assembleCatalog(): Promise<BootRefusal | undefined> {
    const { config, sinks } = this;
    const workspace = config.env?.cwd ?? process.cwd();
    let fallbackProviders: readonly string[] | undefined;
    if (config.models === undefined) {
      let identityWords: string[] | undefined;
      const keyResolver = createLedgerModelKeyResolver({
        workspace,
        role: this.role?.resolved.name ?? 'root',
        sessionId: () => this.id,
        onError: (message) =>
          sinks.debug?.(`[session] credential use not audited: ${message}`),
        // A dummy key that IS its provider's name (LM Studio's `lm-studio`)
        // is identity, not a secret: the catalog's provider and model ids
        // are read once assembled.
        identity: () => {
          if (identityWords !== undefined) return identityWords;
          if (this.models === undefined) return [];
          identityWords = catalogIdentity(this.models);
          return identityWords;
        },
        // `!command` secret refs execute in the run's workspace through the
        // production runner — rerun per request.
        runCommand: createSecretCommandRunner({ cwd: workspace }),
      });
      this.liveSecrets = keyResolver.live;
      const modelsEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const assembled = await assembleModels(
        config.modelsCwd ?? process.cwd(),
        modelsEnv,
        {
          resolveApiKey: keyResolver.resolve,
          ...(config.trustProject === undefined
            ? {}
            : { projectTrust: config.trustProject }),
        },
      );
      // A refused models.json is a config error the user must see: it goes
      // to the warning channel; a successful load is a debug receipt.
      for (const note of assembled.notes) {
        if (note.startsWith('models.json ignored')) sinks.warn(note);
        else sinks.debug?.(note);
      }
      this.assembled = assembled;
      this.models = assembled.models;
      fallbackProviders = assembled.fallbackProviders;
    } else {
      this.models = config.models;
    }
    // The faux testing provider (`KUBIC_PROVIDER=faux`): registered by
    // assembleModels and pinned here, so it is the model that answers —
    // announced on the warning channel, never silent. Any other
    // KUBIC_PROVIDER value is refused by name.
    const override = providerOverrideFromEnv(process.env);
    if (override.kind === 'invalid') {
      return {
        kind: 'provider',
        message: invalidProviderMessage(override.value),
      };
    }
    const fauxPinned = override.kind === 'faux' && config.models === undefined;
    if (fauxPinned) sinks.fauxNotice?.(FAUX_NOTICE);
    const roleModel = this.role?.resolved.model;
    try {
      // An explicit pin wins over default selection; the role layer's own
      // `provider/id` pin is the next default, and with neither the first
      // usable provider is taken (customs first; never a keyless built-in).
      // Enterprise policy and the role's allowed set gate the explicit
      // selection and the implicit pool alike.
      this.model = selectBootModel({
        models: this.models,
        fauxPinned,
        pin: config.model,
        roleModel,
        fallbackProviders,
        policy: config.modelPolicy,
        roleScope: roleModelScope(this.role?.resolved),
      });
    } catch (error) {
      if (error instanceof ModelSelectError) {
        return { kind: 'provider', message: error.message };
      }
      throw error;
    }
    this.explicitModel = hasExplicitModelSelection({
      fauxPinned,
      pin: config.model,
      roleModel,
    });
    this.liveModelRef = `${this.model.provider}/${this.model.id}`;
    return undefined;
  }

  // The approval policy the lane runs under — the same derivation doctor
  // reports. Config classes replace the documented DEFAULT_PERMISSIONS; the
  // destructive, network and confine guards and the approval ask are
  // installed either way, so a run with no config is not a run with no
  // policy.
  private async installApprovalPolicy(env: ExecutionEnv): Promise<void> {
    const { config, request, root, sinks } = this;
    const id = this.id;
    // The explicit flag enables full access for THIS session through the one
    // host enable path (posture.json, one audit row, the shared warning)
    // BEFORE the policy is installed, so the lane boots under the posture
    // the user asked for.
    const grant =
      request.dangerouslySkipApprovals === true
        ? enableSessionFullAccess({
            sessionDir: join(root, id),
            sessionId: id,
            command: request.command,
            workspace: env.cwd,
            onAuditError: (message) =>
              sinks.debug?.(`audit: ledger append failed: ${message}`),
          })
        : undefined;
    this.fullAccessWarning = grant?.warning;
    // Audit identity: the base revision this run started from — `git
    // rev-parse HEAD` captured once here, `none` outside git.
    const base = await resolveRunBaseRevision(env.cwd, (cmd, args) =>
      env.shell
        .spawn(cmd, args, {
          provenance: {
            sessionId: id,
            agentId: config.agentId ?? 'root',
            toolCallId: `${request.command}:base-revision`,
            turnId: 0,
            operation: request.command,
          },
        })
        .wait(),
    );
    this.base = base;
    const role = this.role?.resolved;
    this.installed =
      config.policy ??
      installPolicy({
        workspace: env.cwd,
        // The lane enforces the most restrictive merge of the config classes
        // and the role's — a role declaring `network: none` runs under it
        // even when config allows full — and the role's approval
        // obligations challenge on the triggers. No role means the config
        // (or the lane default).
        ...(role === undefined
          ? config.classes === undefined
            ? {}
            : { classes: config.classes }
          : {
              classes: effectiveRoleClasses(
                { ...DEFAULT_PERMISSIONS, ...config.classes },
                role.classes,
              ),
              ...(role.requires.length === 0
                ? {}
                : { requires: role.requires }),
            }),
        // The layer's own record, so the posture's `source` is the same
        // answer doctor prints.
        source: config.policySource ?? 'default',
        ...(config.approvals ?? {}),
        sessionDir: join(root, id),
        // The session root in use is refused control-plane state.
        sessionsRoot: root,
        // Audit identity for the ledger record of each resolved ask, read at
        // record time.
        sessionId: id,
        model: () => this.liveModelRef,
        thinking: () => this.liveThinkingRef,
        base,
        // The answer seat, when a user is attached to collect verdicts.
        ...(request.answer === undefined ? {} : { answer: request.answer }),
      });
  }

  // The baseline for the end-of-run sweep: captured ONCE, before the first
  // turn, as a metadata walk (hashes only, no blobs). A capture failure is
  // not a boot failure — the sweep then simply has no baseline.
  private beginJournal(env: ExecutionEnv): void {
    const id = this.id;
    this.journal = new FileJournalStore(
      join(this.root, id, 'journal'),
      this.config.journalRetention ?? {},
    );
    try {
      this.reconciliation = beginReconciliation({
        store: this.journal,
        root: env.cwd,
        runId: id,
        sessionId: id,
        // A very large file (or a bridge without ranged reads) is named on
        // the debug channel rather than silently costing its size at boot.
        onNotice: (detail: string) =>
          this.sinks.debug?.(`reconcile: ${detail}`),
        ...(this.config.reconcileOutOfScope === undefined
          ? {}
          : { outOfScope: [...this.config.reconcileOutOfScope] }),
      });
    } catch (error) {
      this.sinks.debug?.(
        `reconcile: baseline capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Two DIFFERENT sessions in one workspace are legal, but each sweeps
  // against its own boot baseline, so a live sibling's in-progress changes
  // land in this session's journal as unattributed, non-reversible entries.
  // The store can show a session, not its liveness, so the line says "may
  // be live". A debug receipt only: never a block, never a boot failure.
  private async probeOverlap(env: ExecutionEnv): Promise<void> {
    const { debug } = this.sinks;
    if (debug === undefined || this.store === undefined) return;
    try {
      const touching = await sessionsTouchingWorkspace(
        this.store,
        env.cwd,
        this.request.context,
      );
      const others = touching.filter((sessionId) => sessionId !== this.id);
      if (others.length > 0) {
        debug(
          `reconcile: another run may be live in this workspace — its in-progress changes will be recorded as unattributed (sessions: ${others.join(', ')})`,
        );
      }
    } catch (error) {
      debug(
        `reconcile: overlap probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  private async bootRunLane(
    env: ExecutionEnv,
  ): Promise<BootRefusal | undefined> {
    const { config, request, sinks } = this;
    const installed = this.requireInstalled();
    const model = this.model;
    const models = this.models;
    const session = this.session;
    const skills = this.skills;
    if (model === undefined || models === undefined || session === undefined) {
      throw new Error('boot steps ran out of order');
    }
    const role = this.role;
    const policy = config.modelPolicy;
    const toolGate =
      policy !== undefined && hasToolPolicy(policy)
        ? (tool: string): boolean => isToolAllowedByEnterprise(policy, tool)
        : undefined;
    // The stored model of a resumed session is gated too: the selection is
    // checked above, the stored one only by this closure.
    const modelGate =
      policy !== undefined && hasModelPolicy(policy)
        ? (provider: string, modelId: string): boolean =>
            isModelAllowed(policy, provider, modelId)
        : undefined;
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
      skills?.block,
    );
    const contributions = [...installed.contributions];
    try {
      this.lane = await bootLane({
        session,
        models,
        model,
        modelPolicy: this.explicitModel ? 'selected' : 'stored',
        onModelNotice: sinks.modelNotice,
        ...(sinks.thinkingNotice === undefined
          ? {}
          : { onThinkingNotice: sinks.thinkingNotice }),
        ...(thinking === undefined ? {} : { thinking }),
        // The session id pins the boot model for the task — escalation is
        // the only path off it.
        taskId: this.id,
        env,
        sessionId: this.id,
        agentId: config.agentId ?? 'root',
        journal: this.journal,
        // An untuned boot omits `stream` — the provider defaults stand.
        ...(stream === undefined ? {} : { settings: { stream } }),
        ...(request.currentTurn === undefined
          ? {}
          : { currentTurn: request.currentTurn }),
        ...(sections === undefined ? {} : { promptSections: sections }),
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
          interceptors: installed.interceptors,
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
    const agent = await this.lane.conversation.agent(this.request.context);
    const live = agent.model;
    const running =
      live === undefined
        ? (this.lane.model as Lane['model'] | undefined)
        : { provider: live.provider, id: live.modelId };
    if (running !== undefined) {
      this.liveModel = { provider: running.provider, id: running.id };
      this.liveModelRef = `${running.provider}/${running.id}`;
    }
    // pi-durable defaults an unset level to `off`, the same answer
    // `/thinking` reports.
    this.thinkingLevel = agent.thinkingLevel;
    this.liveThinkingRef = agent.thinkingLevel ?? 'off';
    return undefined;
  }

  private requireInstalled(): InstalledPolicy {
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

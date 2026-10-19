// biome-ignore-all lint/style/noExcessiveLinesPerFile: one declaration per config key is the point of this module: the parser, the runtime, example.toml and the docs tables all derive from this one list, so splitting it would split that source.
// Every configuration key, declared once: the check its value must pass,
// what the runtime does with it, its environment override and default, its
// value in the example config, and its row in the docs. The parser
// (config.ts), the runtime's effect table (runtime.ts), example.toml and the
// key tables in docs/cli/configuration.md (scripts/gen-config-docs.mjs) all
// derive from this list.
//
// The module imports nothing, so the docs generator loads it as it is.

// What the runtime does with a key. `effect`: the value reaches a code path.
// `kept`: the key is reserved and reported, and the reason it is not consumed
// is stated. `notYetImplemented`: pending work, named.
export type KeyEffect =
  | { readonly effect: string }
  | { readonly kept: string }
  | { readonly notYetImplemented: string };

// The check a key's value must pass (config.ts implements each one, and its
// error message names the key).
export type KeyCheck =
  // A non-empty string.
  | 'string'
  | 'boolean'
  // A non-negative, finite number.
  | 'number'
  // An array of strings.
  | 'strings'
  // A thinking level of the vocabulary.
  | 'thinking'
  // A permission class: a string level or a boolean.
  | 'permission'
  // A positive integer of milliseconds a timer can hold.
  | 'timeoutMs'
  // A non-negative integer.
  | 'count'
  // A non-negative integer of milliseconds a timer can hold.
  | 'retryDelayMs'
  | 'cacheRetention'
  | 'approvalRoute'
  // A non-negative number of milliseconds a timer can hold.
  | 'pendingMs'
  // A positive integer of bytes.
  | 'journalBytes'
  // Relative paths, none empty.
  | 'outOfScope'
  // `provider/id` rungs, no wildcards.
  | 'escalate'
  | 'maxEscalations'
  // A `provider/id` ref.
  | 'roleModel'
  // `provider/id` or `provider/*` entries, or `{ id, thinking? }` tables.
  | 'roleModels'
  // A positive safe integer.
  | 'tokens'
  // A non-empty command string.
  | 'command'
  | 'networkPolicy'
  | 'filesystemPolicy'
  | 'auditSink'
  | 'auditLevel'
  // A facility name, or a number 0–23.
  | 'facility'
  // Files or directories of skills.
  | 'skills';

export interface ConfigKey {
  // The key within its section (`maxBytes`).
  readonly name: string;
  readonly check: KeyCheck;
  // The parsed field, when it differs from the key (`allowed_models` parses
  // into `allowedModels`).
  readonly field?: string;
  // The parse refuses a table without it.
  readonly required?: boolean;
  // The value when nothing sets it. `fill` makes the parse write it.
  readonly default?: string;
  readonly fill?: boolean;
  // The environment variable that overrides it, above every file layer.
  readonly env?: string;
  // What the runtime does with it; absent for a key the section's own row
  // covers (`roles.<name>.model` resolves through `roles`).
  readonly runtime?: KeyEffect;
  // Its TOML value in example.toml, with the comment lines above it.
  readonly example?: string;
  readonly note?: readonly string[];
}

// One row of the docs' key table: the keys it documents (dotted, as the
// parse names them: `roles.<name>.model`, `audit.sink`), and the key column
// when it reads otherwise than those keys in backticks.
interface DocsRow {
  readonly keys: readonly string[];
  readonly label?: string;
  readonly text: string;
}

export interface ConfigSection {
  readonly name: string;
  // `table`: `[name]`. `tables`: `[name.<key>]`, one table per key.
  // `array`: `[[name]]`, an array of tables. `value`: a top-level key.
  readonly shape: 'table' | 'tables' | 'array' | 'value';
  // A section the parse leaves out when none of its keys is set.
  readonly omitEmpty?: boolean;
  // The section's own runtime row (open-ended sections, and a top-level
  // key).
  readonly runtime?: KeyEffect;
  readonly keys: readonly ConfigKey[];
  readonly docs: readonly DocsRow[];
  // The example's tables for a `tables` or `array` section, as
  // `key = value` lines per table.
  readonly exampleTables?: Readonly<Record<string, readonly string[]>>;
  readonly exampleNote?: readonly string[];
}

// The request options `[model]` and `[roles.<name>]` share. `timeoutMs`
// bounds one provider request (0 would refuse every request, so it is
// refused by name); `maxRetries`/`maxRetryDelayMs` are non-negative (0
// disables retries / the delay cap — both real provider meanings, never
// "unset"); `cacheRetention` names Pi's retention vocabulary.
const REQUEST_OPTIONS = [
  { name: 'timeoutMs', check: 'timeoutMs' },
  { name: 'maxRetries', check: 'count' },
  { name: 'maxRetryDelayMs', check: 'retryDelayMs' },
  { name: 'cacheRetention', check: 'cacheRetention' },
] as const satisfies readonly ConfigKey[];

const PERMISSION_EFFECT = {
  effect: 'permission classes for the lane: derived tool allowlist',
} as const;

const VERIFY_COMMAND_EFFECT = (gate: string): KeyEffect => ({
  effect: `${gate} gate: a shell command (sh -c) run in the worktree after each run settles, outside approvals and recorded in the audit ledger; exit status → signal:${gate}`,
});

export const CONFIG_SECTIONS = [
  {
    name: 'agent',
    shape: 'table',
    omitEmpty: true,
    keys: [
      {
        name: 'name',
        check: 'string',
        runtime: { effect: 'agent id on the lane + journal attribution' },
        example: '"kubic"',
      },
      {
        name: 'systemPromptFile',
        check: 'string',
        runtime: {
          effect:
            'file whose contents the run, tui and replay lanes append to the assembled system prompt (ahead of the skills block)',
        },
        example: '"SYSTEM.md"',
        note: [
          'Prompt augmentation: the sibling SYSTEM.md',
          'is read at load and appended to the assembled lane prompt (ahead of the',
          'skills block) for run, tui and replay. Relative to this',
          "file's directory; a leading ~/ expands to home. A project-layer path",
          'additionally requires trust and containment in the project root; a missing',
          'or unreadable file is a named ConfigError, never a silent skip.',
        ],
      },
    ],
    docs: [
      {
        keys: ['agent.name'],
        text: "The lane's agent id: journal entries are attributed to it. Unset ⇒ `root`, unchanged.",
      },
      {
        keys: ['agent.systemPromptFile'],
        text: "Prompt augmentation: a path whose contents are read at load and appended to the assembled system prompt — ahead of the skills block — for `kubic run`, `kubic tui` and the live tiers of `kubic replay`. A leading `~/` expands to the home directory; a relative path resolves against the declaring config file's directory, so the shipped example's `SYSTEM.md` travels with `example.toml`. Global-layer paths are always allowed; a project-layer path applies only when the project is trusted (an untrusted project's file is refused pre-trust with the trust message, before it is read) and must resolve inside the project root — a trusted path outside it, or a symlink whose target lies outside it, is refused by name. A missing or unreadable file is a named `ConfigError`, never a silent skip. `kubic config` reports the effective (resolved) path; the contents never render.",
      },
    ],
  },
  {
    name: 'model',
    shape: 'table',
    keys: [
      {
        name: 'provider',
        check: 'string',
        env: 'KUBIC_MODEL',
        runtime: {
          effect:
            'provider selection for `kubic run` and `kubic tui` (selectModel)',
        },
        example: '"local"',
      },
      {
        name: 'id',
        check: 'string',
        env: 'KUBIC_MODEL',
        runtime: {
          effect:
            'model selection for `kubic run` and `kubic tui` (selectModel)',
        },
        example: '"llama3"',
      },
      {
        name: 'thinking',
        check: 'thinking',
        env: 'KUBIC_MODEL_THINKING',
        runtime: {
          effect:
            'thinking level the run/tui lane boots with (clamped to the model); per-run override is --thinking, then KUBIC_MODEL_THINKING',
        },
        example: '"medium"',
      },
      {
        ...REQUEST_OPTIONS[0],
        runtime: {
          effect:
            'per-request provider timeout on the lane (`settings.stream`), layered per role by `[roles.<name>].timeoutMs`',
        },
      },
      {
        ...REQUEST_OPTIONS[1],
        runtime: {
          effect:
            'provider/SDK retries inside one request attempt on the lane (`settings.stream`), layered per role by `[roles.<name>].maxRetries`',
        },
      },
      {
        ...REQUEST_OPTIONS[2],
        runtime: {
          effect:
            'cap on the server-requested retry delay on the lane (`settings.stream`), layered per role by `[roles.<name>].maxRetryDelayMs`',
        },
      },
      {
        ...REQUEST_OPTIONS[3],
        runtime: {
          effect:
            'prompt cache retention preference on the lane (`settings.stream`), layered per role by `[roles.<name>].cacheRetention`',
        },
      },
      {
        name: 'escalate',
        check: 'escalate',
        runtime: {
          effect:
            'escalation ladder rungs the run/tui lane climbs one-way; a role escalate wins for that role',
        },
      },
      {
        name: 'maxEscalations',
        check: 'maxEscalations',
        runtime: {
          effect:
            'climbs allowed per run on the escalation ladder; unset means the ladder length',
        },
      },
    ],
    docs: [
      {
        keys: ['model.provider', 'model.id'],
        text: 'Selects the provider/model for `kubic run` and `kubic tui` (`selectModel`); `--model` and `KUBIC_MODEL` beat it as the `cli`/`env` layers of the config load, and a frozen enterprise `[model]` beats all of them (announced on stderr).',
      },
      {
        keys: [
          'model.escalate',
          'model.maxEscalations',
          'roles.<name>.escalate',
        ],
        text: "The escalation ladder: `escalate` lists the rungs as concrete `provider/id` refs in climbing order (wildcards refused per entry at load); a role's `escalate` wins outright for runs as that role, even an empty list (which freezes every `/model` switch — opting out of climbing, not of the gate). `maxEscalations` bounds the climbs per run, unset meaning the ladder length. Climbs are one-way (a down-step or off-ladder target is refused by name with the live model untouched) and recorded: `/model <ref>` climbs the ladder silently, `/escalate <ref> [reason]` climbs naming why, and three consecutive tool-failure turns climb one rung automatically — once per run, never back (`kubic run` settles one turn per invocation, so the automatic trigger lives on the `kubic tui` lane). Every climb appends an `escalation: <from> → <to> (<reason>)` transcript row and lands on the trajectory's `model.escalations` (per-model usage already attributes the spend each side of the move).",
      },
      {
        keys: ['model.thinking'],
        text: "The file-layer thinking default. The lane boots with the winner of `--thinking` > `KUBIC_MODEL_THINKING` > session record > role default > this key, clamped to the effective model's supported levels (a clamp is one stderr notice naming the model, the request and the level applied, never a silent rewrite); the applied level is committed to the session and recorded in `trajectory.json`. A level the vocabulary does not know is refused by name at load.",
      },
      {
        keys: [
          'model.timeoutMs',
          'model.maxRetries',
          'model.maxRetryDelayMs',
          'model.cacheRetention',
        ],
        text: 'Request options on the lane (`settings.stream`): `timeoutMs` bounds one provider request (a positive integer of milliseconds), `maxRetries` caps the provider/SDK retries inside one request attempt and `maxRetryDelayMs` caps the delay a server may ask for before a retry (non-negative integers: `0` disables retries / the cap), and `cacheRetention` is the prompt cache preference (`none`, `short`, `long`). `[roles.<name>]` layers each of them per key for runs as that role. A mistyped value is refused by name at load.',
      },
    ],
  },
  {
    name: 'approvals',
    shape: 'table',
    keys: [
      {
        name: 'route',
        check: 'approvalRoute',
        default: 'ask-user',
        fill: true,
        env: 'KUBIC_APPROVALS_ROUTE',
        runtime: { effect: 'approval routing (ask-user | deny)' },
        example: '"ask-user"',
      },
      {
        name: 'maxPendingMs',
        check: 'pendingMs',
        runtime: {
          effect:
            'pending-approval bound on the lane; a pending ask denies on timeout',
        },
        example: '30000',
      },
      {
        name: 'autoApprove',
        check: 'strings',
        runtime: {
          effect:
            'explicit-only capability auto-approvals on the lane (never inferred)',
        },
        example: '[]',
      },
      {
        name: 'sessionScoped',
        check: 'boolean',
        runtime: {
          effect:
            'per-session approval store (true only; false is refused — no shared store exists)',
        },
        example: 'true',
      },
      {
        name: 'requireJustification',
        check: 'boolean',
        runtime: {
          effect:
            'installed on the lane: an approval without justification is denied',
        },
        example: 'false',
      },
    ],
    docs: [
      {
        keys: ['approvals.route'],
        text: "Approval routing (`ask-user` \\| `deny`), installed by `kubic run`, `kubic tui`, `kubic replay` and reported by doctor's `policy:installed` line. `deny` refuses every challenged call with `denied by policy route` (exit 4) and never opens the TUI overlay — `autoApprove` entries never apply under it (the lane denies them too, and doctor fails `policy:approvals` for the combination). `KUBIC_APPROVALS_ROUTE` overrides it.",
      },
      {
        keys: [
          'approvals.maxPendingMs',
          'approvals.autoApprove',
          'approvals.sessionScoped',
          'approvals.requireJustification',
        ],
        label:
          '`approvals.maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification`',
        text: "Installed on the lane (`run`, `tui`, `replay`) from the same projection doctor prints, so `policy:approvals` and `policy:installed` always show the same route and bound (doctor fails `policy-mismatch` if they ever differ). `maxPendingMs` bounds the TUI overlay: an unanswered ask denies on timeout. `autoApprove` is explicit-only and applies headless too (the audit record says `approved by autoApprove`), except for an always-ask capability (`kubic-state-write`): naming it is accepted but ignored — it takes the normal ask path (the TUI seat, or the instant no-surface refusal headless, never a `maxPendingMs` stall), `kubic doctor`'s `policy:approvals` line warns by name and `kubic config` counts it as not auto-approved. `requireJustification = true` denies any approval that carries no justification (the TUI overlay and `autoApprove` supply none, so every challenged call is refused). `sessionScoped = false` is refused by the config load: decisions are always stored per session. Only real answers (user, route, autoApprove) persist to `approvals.json` — a timeout denies the call but stores nothing, so a later surface can still ask about the same operation.",
      },
    ],
  },
  {
    name: 'permissions',
    shape: 'table',
    keys: [
      {
        name: 'filesystem',
        check: 'permission',
        runtime: PERMISSION_EFFECT,
        example: '"workspace-write"',
      },
      {
        name: 'shell',
        check: 'permission',
        runtime: PERMISSION_EFFECT,
        example: 'true',
      },
      {
        name: 'network',
        check: 'permission',
        runtime: PERMISSION_EFFECT,
        example: '"none"',
      },
      {
        name: 'git',
        check: 'permission',
        runtime: PERMISSION_EFFECT,
        example: '"workspace"',
      },
      {
        name: 'credentials',
        check: 'permission',
        runtime: PERMISSION_EFFECT,
        example: '"none"',
      },
    ],
    docs: [
      {
        keys: [
          'permissions.filesystem',
          'permissions.shell',
          'permissions.network',
          'permissions.git',
          'permissions.credentials',
        ],
        label: '`permissions.*`',
        text: 'Permission classes → the lane\'s derived tool allowlist. `shell = "read-only-allowlist"` keeps `bash` but enforces an explicit read-only command allowlist at the guard: every `|`/`||`/`&&`/`;`/`&`/newline segment must head with `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find` or `git`, and then only in its read-only form — `git status`/`diff`/`log`/`show` (after global options like `-C`/`--no-pager`, without `--output`, and never `-c`/`--config-env`/`--exec-path`/`--upload-pack`/`--receive-pack`, which can execute code), `find` without `-exec*`/`-ok*`/`-delete`/`-fprint*`/`-fls`, `rg` without `--pre`/`--hostname-bin`. Redirection (`>`, `>>`, any fd form) is refused, `sed`/`perl` with `-i`/`--in-place` are refused, and any other verb (`tee`, `rm`, `npm`, `node`, `cp`, …) is blocked by name. Expansion and substitution are never interpreted and are refused outright — `$(…)`, backticks, `<(...)` process substitution and any unquoted `$` (single-quoted text is literal and stays readable) — because an allowed head verb could otherwise launder another command. The parser is lexical, so it over-blocks rather than under-blocks; `shell = true` is unchanged (no allowlist).',
      },
    ],
  },
  {
    name: 'journal',
    shape: 'table',
    keys: [
      {
        name: 'retentionDays',
        check: 'number',
        env: 'KUBIC_JOURNAL_RETENTION_DAYS',
        runtime: {
          effect:
            'journal age bound (maxAgeMs) enforced on every append; 0 is retention off',
        },
        example: '30',
      },
      {
        name: 'maxBytes',
        check: 'journalBytes',
        default: '100 MiB',
        runtime: {
          effect:
            'journal byte bound — index.jsonl plus the blobs it references — enforced on every append; unset ⇒ the 100 MiB default',
        },
      },
      {
        name: 'outOfScope',
        check: 'outOfScope',
        runtime: {
          effect:
            'paths excluded from the baseline and the end-of-run sweep (self + children)',
        },
      },
    ],
    docs: [
      {
        keys: ['journal.retentionDays'],
        text: 'Journal age bound (days), enforced on every append. `0` means retention is off: no age bound is installed, the same reading `kubic journal prune --keep-days 0` has, and `kubic config` prints `journal retention: off`. Unset installs no bound either. It is also the default keep window of `kubic journal prune` (`--keep-days` overrides it).',
      },
      {
        keys: ['journal.maxBytes'],
        text: 'Journal byte bound, enforced on every append: the store — `index.jsonl` plus the blobs it references — is pruned to stay under it, and a pass that has to prune frees a tenth of the bound (the headroom the next appends need). Content addressing dedupes blobs, so a file toggling between two contents (a formatter fighting the agent, repeated `undo --step`) grows the journal through its lines alone; this key is what keeps that bounded. A positive integer (0 is refused by name: it is not "retention off" — unset is — it is a bound nothing fits). Unset ⇒ 100 MiB (`DEFAULT_JOURNAL_MAX_BYTES`). An entry whose own content cannot fit is refused before anything is written, so the tool call fails as `journal_failed` with the file untouched, and a pass that has to prune never drops the newest entry — the store stays over its bound by that entry instead.',
      },
      {
        keys: ['journal.outOfScope'],
        text: 'Paths excluded from the baseline and the end-of-run sweep (self + children): `outOfScope = ["dist"]` ⇒ `dist/`, `dist/**`. Path-boundary aware (`dist` never matches `dist-x`), plain paths only, empty entries refused by name.',
      },
    ],
  },
  {
    name: 'roles',
    shape: 'tables',
    runtime: {
      effect:
        'per-role model/tool/thinking/request-option defaults, requires and the allowed model set, layered under the role document',
    },
    keys: [
      { name: 'model', check: 'roleModel' },
      { name: 'tools', check: 'strings' },
      { name: 'requires', check: 'strings' },
      { name: 'thinking', check: 'thinking' },
      { name: 'models', check: 'roleModels' },
      { name: 'escalate', check: 'escalate' },
      ...REQUEST_OPTIONS,
    ],
    exampleTables: {
      reviewer: [
        'model = "local/llama3"',
        'tools = ["read", "grep", "diff"]',
        'models = ["local/*", { id = "acme/big", thinking = "high" }]',
      ],
      implementer: [
        'model = "local/llama3"',
        'tools = ["read", "write", "edit", "bash"]',
      ],
    },
    docs: [
      {
        keys: [
          'roles.<name>.model',
          'roles.<name>.tools',
          'roles.<name>.thinking',
          'roles.<name>.requires',
          'roles.<name>.models',
          'roles.<name>.timeoutMs',
          'roles.<name>.maxRetries',
          'roles.<name>.maxRetryDelayMs',
          'roles.<name>.cacheRetention',
        ],
        label:
          '`roles.<name>.model`, `roles.<name>.tools`, `roles.<name>.thinking`, `roles.<name>.requires`, `roles.<name>.models`',
        text: "Per-role defaults layered under the role document for `kubic run --role <name>`: `model` is a `provider/id` pin the run selects unless an explicit `--model`/`[model]` pin wins, `tools` replaces the document's own list, `thinking` is the role's thinking default — below the session's stored level and any `--thinking`/`KUBIC_MODEL_THINKING` override, above the `[model].thinking` file default — `requires` names tools that always require approval under the role — unioned with the document's own `requires:` list, never subtracted. `models` is the role's allowed model set: entries are `\"provider/id\"` or `\"provider/*\"` strings, or `{ id, thinking? }` tables whose thinking beats the flat role default for the matched model — an empty set (or none) allows every registered model, a malformed entry is refused by name at load, and selection plus every `/model` switch resolve against it, refusing out-of-set by name (`kubic config` renders the winning layer's list with provenance; `/scoped-models` reports the resolved set on the TUI lane). Each leaf is attributed to the layer that set it (enterprise > product > global > project > workspace > session > agent). A malformed model ref, an unknown thinking level, a malformed set entry, or a mistyped request option is refused by name at load. Scope: `kubic run --role` and `kubic tui --role` both apply the whole layer (model pin + tools + thinking + requires + models) and install the most restrictive merge of the config classes and the role's (a role declaring `network: none` runs under it even when config allows full); the TUI also takes the `[agent].name` agent id. No role, model or provider is invented when none of those levels sets one. `timeoutMs`/`maxRetries`/`maxRetryDelayMs`/`cacheRetention` layer over the `[model]` request tuning per key for runs as that role.",
      },
      {
        keys: [],
        label:
          '`.kubic/roles/<name>.md` frontmatter `name`, `description`, `model`',
        text: "The role document's own Pi-agent keys: `name` aliases `role` (a document disagreeing with itself is refused by name), `description` is shown by `kubic doctor` in the role detail, and `model` is a `provider/id` pin validated at parse (a malformed ref is refused with its reason before any lane boots). Precedence for the model pin: an explicit CLI pin beats `[roles.<name>].model`, which beats the document pin (a layer winning over the document is precedence, never an overridden attempt); the winning pin reaches `kubic run --role`/`kubic tui --role` through the existing role-model selection.",
      },
    ],
  },
  {
    name: 'ui',
    shape: 'table',
    keys: [
      {
        name: 'theme',
        check: 'string',
        default: 'default',
        runtime: {
          effect:
            'TUI theme: a built-in name (`default`, `dark`, `light`, `terminal`) or a path to a JSON theme file, resolved and validated before the alt-screen opens (a missing or invalid file is a named `error:` line and exit 2)',
        },
        example: '"dark"',
      },
      {
        name: 'statusBar',
        check: 'boolean',
        runtime: {
          kept: 'the status bar is always shown; the key is parsed and reported but hides nothing',
        },
        example: 'true',
      },
    ],
    docs: [
      {
        keys: ['ui.theme'],
        text: 'TUI theme (token themes). A built-in name — `default` or `dark` (the shipped Konic brand palette), `light` (for light terminal backgrounds) or `terminal` (your terminal\'s own colours: no backgrounds of its own, semantic colours on the ANSI palette slots) — or a path to a JSON theme file, read relative to the current directory (an absolute path is taken as typed). Resolved and validated **before the alt-screen opens**: a missing file, malformed JSON, an unknown key or colour, an unknown `extends` base, or a value that is not `#rrggbb` is one `error: theme \'<ref>\': …` line on stderr and exit 2 (the message never quotes the file). A theme assigns colours to the design-token roles: `bg0`–`bg3` surfaces, `fg0`–`fg3` text levels, `accent`/`accentBg`, `ok`/`okBg`, `warn`/`warnBg`, `err`/`errBg`, `info`, `add`/`addBg`, `del`/`delBg`, `addWordBg`/`delWordBg` (the changed words of a diff line). Schema (v2): `{ "name": "mine", "extends": "dark", "colors": { "accent": "#00aaff", "bg2": "#202030" } }` — any subset of roles; the rest come from `extends` (`default`/`dark` when absent). A v1 file (exactly the seven keys `accent`, `warm`, `success`, `error`, `warning`, `muted`, `prompt`) is still accepted and mapped onto the dark palette (`accent`→accent, `success`→ok, `error`→err, `warning`→warn, `muted`→fg2, `prompt`→fg0; `warm` is accepted and unused); a file cannot mix v1 keys with `extends`. Every colour is downgraded to the terminal\'s colour level (truecolor RGB, else the nearest xterm-256 entry, else the nearest ANSI colour — surfaces drop their background at 16 colours except the selection — and the identity under `NO_COLOR`). Unset ⇒ `default`.',
      },
      {
        keys: ['ui.statusBar'],
        text: 'Kept: the status bar is always shown. The key is parsed and reported but hides nothing.',
      },
    ],
  },
  {
    name: 'session',
    shape: 'table',
    keys: [
      {
        name: 'store',
        check: 'string',
        runtime: {
          kept: 'jsonl is the only store; the key is parsed and reported, and sqlite/memory are not implemented',
        },
        example: '"jsonl"',
      },
      {
        name: 'dir',
        check: 'string',
        runtime: {
          notYetImplemented:
            'sessions stay under ~/.kubic/sessions; the key does not relocate them',
        },
        example: '".kubic/sessions"',
      },
      {
        name: 'retentionDays',
        check: 'number',
        runtime: {
          effect:
            'default keep-window for `kubic sessions prune` (deletion stays explicit)',
        },
        example: '30',
      },
      {
        name: 'autoCompact',
        check: 'boolean',
        runtime: {
          effect:
            'threshold compaction on the lane (run, tui): false disables it, true is the automatic default',
        },
        example: 'true',
        note: [
          'Compaction policy: automatic threshold compaction, a 4000-token',
          'reserved room and a 5000-token verbatim recent window on the run and tui',
          'lanes. All three are optional — unset means the lane defaults',
          '(automatic, 16384 reserved, 20000 kept recent).',
        ],
      },
      {
        name: 'reserveTokens',
        check: 'tokens',
        default: '16384',
        runtime: {
          effect:
            'reserved-room tokens on the lane (run, tui), clamped per model to at most a quarter of its context window',
        },
        example: '4000',
      },
      {
        name: 'keepRecentTokens',
        check: 'tokens',
        default: '20000',
        runtime: {
          effect:
            'verbatim recent-context window on the lane (run, tui), capped per model to a quarter of the room below its reserve',
        },
        example: '5000',
      },
    ],
    docs: [
      {
        keys: ['session.store'],
        text: 'Kept: `jsonl` is the only store. The key is parsed and reported; `sqlite` and `memory` are not implemented.',
      },
      {
        keys: ['session.dir'],
        text: 'Not implemented: sessions stay under `~/.kubic/sessions`, and the key does not relocate them.',
      },
      {
        keys: ['session.retentionDays'],
        text: 'Default keep-window (days) for `kubic sessions prune`: `--keep-days` overrides it. `0` means retention is off — prune exits 0 with `session retention is off (keep-days 0) — nothing is pruned`; unset, prune exits 1 naming both ways to set a window (`--keep-days`, or this key) rather than inventing one. Deletion stays explicit (`--yes`), dry-run is the default, and a session holding a live lock is never pruned — the lock is re-checked immediately before each delete, so a session locked between plan and delete is skipped too. The same window self-heals session journals at read time: `kubic log` (with `--session <id>` or the latest-session fallback) drops aged entries as it reads them — with retention unset, or `0`, the log path writes nothing. `kubic journal prune` reads `[journal] retentionDays` instead (see the paragraph below the table).',
      },
      {
        keys: ['session.autoCompact'],
        text: 'Threshold compaction on the lane (`run`, `tui`): `false` disables it, `true` (and unset) keeps the automatic default. A non-boolean is refused by name.',
      },
      {
        keys: ['session.reserveTokens'],
        text: 'Reserved-room tokens before the lane compacts: unset ⇒ 16384. A value that is not a positive integer is refused by name. The effective reserve is clamped per model to at most a quarter of its context window (an 8192-token model reserves 2048), so a small-window model compacts sooner than the configured figure; `kubic config` and `kubic doctor` print the effective reserve.',
      },
      {
        keys: ['session.keepRecentTokens'],
        text: 'Verbatim recent-context window the lane keeps across a compaction: unset ⇒ 20000. A value that is not a positive integer is refused by name. The effective window is capped per model to a quarter of the room below its reserve (window − reserve), so it scales with the model: an 8192-token model keeps 1536, a 16384-token model 3072, a 32768-token model 6144, and the configured 20000 applies from a 96384-token window up. A `/compact` keeps at most 2000 tokens verbatim, whatever the window.',
      },
    ],
  },
  {
    name: 'verify',
    shape: 'table',
    keys: [
      {
        name: 'tests',
        check: 'command',
        runtime: VERIFY_COMMAND_EFFECT('tests'),
        example: '"npm test"',
      },
      {
        name: 'build',
        check: 'command',
        runtime: VERIFY_COMMAND_EFFECT('build'),
      },
      {
        name: 'lint',
        check: 'command',
        runtime: VERIFY_COMMAND_EFFECT('lint'),
      },
      {
        name: 'typecheck',
        check: 'command',
        runtime: VERIFY_COMMAND_EFFECT('typecheck'),
        example: '"npm run typecheck"',
      },
      {
        name: 'timeoutMs',
        check: 'timeoutMs',
        default: '600000',
        runtime: {
          effect:
            'per-command bound for the [verify] gates (a timeout is a fail)',
        },
        example: '600000',
      },
    ],
    docs: [
      {
        keys: [
          'verify.tests',
          'verify.build',
          'verify.lint',
          'verify.typecheck',
        ],
        text: "The gate commands (see [Gate verification](#gate-verification-verify)). After each `kubic run` settles, each configured command runs as `sh -c <command>` in the run's worktree and its exit status becomes the trajectory's `signal:<gate>` label (0 = `pass`). A gate with no command stays `unknown`. A blank or non-string command is refused by name at load. The command runs outside the approval interceptors, so each run of one is announced on stderr (`verify: running the <gate> gate: <command>`) and recorded as a `verify:<gate>` row in the audit ledger, and `kubic config` lists the commands that will run. A trusted project's config can set them: the trust question says so.",
      },
      {
        keys: ['verify.timeoutMs'],
        text: 'Per-command bound for the `[verify]` gates, a positive integer of milliseconds up to 2147483647 (default 600000). A command still running at the bound is killed and its gate is `fail`.',
      },
    ],
  },
  {
    name: 'policy',
    shape: 'table',
    runtime: {
      kept: 'enterprise policy section: resolved once per process into the effective policy; the per-key rows below say what each key does',
    },
    keys: [
      {
        name: 'allowed_models',
        field: 'allowedModels',
        check: 'strings',
        runtime: {
          effect:
            'model selection gate (`provider/id`, `provider/*`, bare ids) before any provider call',
        },
        example: '["local/*"]',
      },
      {
        name: 'allowed_providers',
        field: 'allowedProviders',
        check: 'strings',
        runtime: {
          effect:
            'provider gate shared by model selection and the implicit fallback pick',
        },
        example: '["local"]',
      },
      {
        name: 'allowed_tools',
        field: 'allowedTools',
        check: 'strings',
        runtime: {
          effect:
            'lane tool intersection (active tools and the prompt tools line); a lower layer cannot widen it',
        },
        example:
          '["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]',
      },
      {
        name: 'denied_tools',
        field: 'deniedTools',
        check: 'strings',
        runtime: {
          effect:
            'lane tool intersection; the deny holds against every lower layer, role document and model grant',
        },
        example: '[]',
      },
      {
        name: 'network_policy',
        field: 'networkPolicy',
        check: 'networkPolicy',
        runtime: {
          kept: 'resolved into the effective policy but NOT enforced: Kubic has no proxy-mediated enforcement, so the key is listed here rather than silently ignored (doctor does not report it)',
        },
        example: '"proxy"',
      },
      {
        name: 'allowed_domains',
        field: 'allowedDomains',
        check: 'strings',
        runtime: {
          kept: 'resolved into the effective policy alongside network_policy; Kubic has no live network enforcement',
        },
        example: '["registry.npmjs.org", "github.com"]',
      },
      {
        name: 'filesystem_policy',
        field: 'filesystemPolicy',
        check: 'filesystemPolicy',
        runtime: {
          kept: 'resolved into the effective policy but NOT enforced as its own gate: the lane derives filesystem reach from the [permissions] classes',
        },
        example: '"workspace-only"',
      },
      {
        name: 'data_policy',
        field: 'dataPolicy',
        check: 'string',
        runtime: {
          kept: 'carried and reported; no local mechanism can promise a provider-side training policy, so it is never claimed as enforced',
        },
        example: '"no-external-training"',
      },
      {
        name: 'logging_policy',
        field: 'loggingPolicy',
        check: 'string',
        runtime: {
          kept: 'carried and reported; the audit ledger is not selected by this key',
        },
        example: '"full-audit"',
      },
    ],
    docs: [
      {
        keys: ['policy.allowed_models'],
        text: 'The model gate: `provider/id`, `provider/*` (or `*` glob) patterns and bare model ids. A selection outside the list — `--model`, `[model]`, `KUBIC_MODEL`, a role pin, or the implicit first-available pick — exits 6 with a named policy refusal before any provider call; the implicit pick skips disallowed providers. It gates `kubic run`, `kubic tui` (boot and `/model` switches — a refused switch leaves the live model untouched) and the re-executing tiers of `kubic replay`.',
      },
      {
        keys: ['policy.allowed_providers'],
        text: 'The provider gate, applied with `allowed_models`: both lists intersect, so a provider the list omits is refused even when a pattern would name the model.',
      },
      {
        keys: ['policy.allowed_tools', 'policy.denied_tools'],
        text: "The lane tool intersection: `kubic run`/`kubic tui` (and the re-executing tiers of `kubic replay`) activate only tools that survive it, and the system prompt's `tools:` line names exactly that set. A deny holds against every lower layer, a role document and the model — a role that declares a denied tool is refused by name, while a role that declares none of them is unaffected by a deny-only policy. With no allow list, only the deny list narrows; with one, anything outside it is refused.",
      },
      {
        keys: ['policy.network_policy', 'policy.allowed_domains'],
        text: 'Parsed and resolved into the effective policy: `"proxy"` is carried as the engine\'s allowlist mode. **Not enforced:** Kubic has no proxy-mediated enforcement, so these keys protect nothing; `kubic config` lists them (`kept`) rather than the section being silently ignored. `kubic doctor` reports the one shape it can judge: an `allowlist` with no domains is unenforceable and fails `policy:enterprise-network`; proxy-mediated enforcement itself stays unreported. The engine mode names (`none`, `allowlist`, `full`) are accepted too.',
      },
      {
        keys: ['policy.filesystem_policy'],
        text: "Parsed and resolved (`workspace-only` is the engine's `workspace-write`; the engine level names are accepted). The lane derives filesystem reach from the `[permissions]` classes, so this value is **not enforced** as a gate of its own; `kubic config` lists it (`kept`), `kubic doctor` does not report it.",
      },
      {
        keys: ['policy.data_policy', 'policy.logging_policy'],
        text: 'Parsed and carried (for example `no-external-training`, `full-audit`); no local mechanism can promise a provider-side policy, so they are reported, never claimed as enforced.',
      },
    ],
  },
  {
    name: 'audit',
    shape: 'array',
    runtime: {
      kept: '[[audit]] sinks are parsed, validated and built: appendToLedger fans every audit row out to the configured sinks plus the mandatory repo ledger (level = privileged keeps decisions and privileged actions only)',
    },
    keys: [
      { name: 'sink', check: 'auditSink', required: true },
      { name: 'level', check: 'auditLevel', required: true },
      { name: 'target', check: 'string' },
      { name: 'facility', check: 'facility' },
    ],
    exampleTables: {
      syslog: ['sink = "syslog"', 'level = "privileged"'],
    },
    docs: [
      {
        keys: ['audit.sink', 'audit.level', 'audit.target', 'audit.facility'],
        label: '`audit` (`[[audit]]`)',
        text: 'Sink tables (`sink` = `syslog` \\| `file` \\| `memory`, `level` = `privileged` \\| `all`, optional `target`/`facility`). Parsed and validated fail-closed (an unknown kind, level or key is named); every audit row fans out to the configured sinks plus the mandatory repo ledger (see [Audit sinks](enterprise.md#audit-sinks-audit)).',
      },
    ],
  },
  {
    name: 'skills',
    shape: 'value',
    runtime: {
      effect:
        'settings skills for `kubic run` and `kubic tui` (loaded with source `settings`)',
    },
    keys: [
      {
        name: 'skills',
        check: 'skills',
        example: '["./skills"]',
        note: [
          'Settings skills: files or directories, resolved',
          "against this file's directory — `./skills` names `<root>/.kubic/skills`",
          '(`../skills` would name `<root>/skills`).',
        ],
      },
    ],
    docs: [
      {
        keys: ['skills'],
        text: 'Settings skills: files or directories loaded with source `settings` on every lane a command boots — `kubic run`, `kubic tui`, the suite runs of `kubic eval`/`kubic benchmark` and the re-executing tiers of `kubic replay` (see [Settings skills](#settings-skills)). Project-layer entries apply only for a trusted project; a non-string or blank entry is refused by name at load.',
      },
    ],
  },
] as const satisfies readonly ConfigSection[];

// The example config's header (read by the docs generator, not the
// product).
/** @internal */
export const EXAMPLE_HEADER = [
  'Kubic canonical config example.',
  'Committed to the repo: .kubic/config.toml + .kubic/roles/*.md',
  'Never committed: sessions/ journal/ artifacts/ audit/',
] as const;

// One key's declaration, by its section and name.
export function configKey(section: string, name: string): ConfigKey {
  const found = CONFIG_SECTIONS.find(
    (candidate) => candidate.name === section,
  )?.keys.find((key) => key.name === name);
  if (found === undefined)
    throw new Error(`no config key '${section}.${name}'`);
  return found;
}

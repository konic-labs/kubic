# `@kubic/agent`

> Permission classes and skills for the agent lane.
> Source: `packages/agent/src`.
>
> File name note: this page lives at `agents-pkg.md` (not `agents.md`)
> because the harness reserves the `agents.md` filename; it is still the
> canonical page for `packages/agent`.

`@kubic/agent` owns two things the lane is built from: the five
permission classes that shape the tool set, and the skill registry that
discovers, gates and injects skills. Neither is a boundary — solo mode has
no isolation; the classes decide which tools the model is offered.

## Public API (`packages/agent/src`)

| Module | Exports |
| --- | --- |
| `policy.ts` | `PermissionClasses`, `FILESYSTEM_LEVELS`, `ShellLevel`, `SHELL_LEVELS`, `NetworkLevel`, `NETWORK_LEVELS`, `GIT_LEVELS`, `CredentialLevel`, `CREDENTIAL_LEVELS`, `SOLO_DEFAULTS`, `toolsForClasses`, `AgreementCheck`, `checkAgreement`, `checkGrantable`, `UnsupportedLevel`, `effectiveNetworkLevel`, `effectiveCredentialLevel`, `checkExpressible`, `describeUnsupported`, `validateClasses`, `PolicyValidationError`, `RunMode` |
| `skills/skills.ts` | Skill registry: `discoverSkills`, `gateSkills`, `formatSkillsForSystemPrompt`, `invokeSkill`, `expandSkillInvocation`, `parseSkillFile` and their types |
| `index.ts` | No barrel — import per-module paths |

## Permission classes (`policy.ts`)

| Class | Levels | Solo default |
| --- | --- | --- |
| `filesystem` | `none`, `read`, `workspace-write`, `full` | `workspace-write` |
| `shell` | `false`, `read-only-allowlist`, `true` | `true` |
| `network` | `none`, `allowlist`, `full` | `none` |
| `git` | `false`, `workspace`, `full` | `workspace` |
| `credentials` | `none`, `allowlist` | `none` |

`toolsForClasses` derives the tool allowlist from the classes;
`checkAgreement` refuses a tool list that contradicts them and
`checkGrantable` refuses classes that demand a tool the lane did not
register — both with a named reason, never by silently narrowing. A level
the tool set cannot express is reported by `checkExpressible` as
unsupported (naming the level the lane actually enforces), never silently
widened. `RunMode` is `autonomous` only when the user asked for it
explicitly (`--autonomous`) and `interactive` otherwise; it is recorded on
the session and in the audit trail.

## Skills (`skills/skills.ts`)

Markdown-only skills from local files: user roots (`~/.pi/agent/skills`,
`~/.agents/skills`), project roots (`.pi/skills` and `.agents/skills` from
the cwd up to the git top level, after the project is trusted),
package-declared skill directories, the settings array and repeatable
`--skill` paths. Later sources shadow earlier ones on a name conflict.
There is no fetcher, no installer and no network: every skill resolves to
a local `SKILL.md`, and every read goes through the injected exec
`FileBridge`. `gateSkills` hides a skill whose required tools the run
does not grant; `formatSkillsForSystemPrompt` renders the visible ones
into the prompt. Command behaviour is on the
[CLI pages](../cli/commands.md).

## Dep-direction neighbours

- May import: [@kubic/core](core.md), [@kubic/exec](exec.md) only — never
  host/worker/tui/trajectory/eval.
- Imported by: [@kubic/agent](worker.md), [@kubic/host](host.md).

```text
core, exec ──→ agents ──→ worker, host
```

Back to the [docs index](../README.md).

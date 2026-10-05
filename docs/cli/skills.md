# Skills

> Design ref: §29 (skills discovery, gating and prompt injection).
> Implementation: `packages/agents/src/skills/skills.ts` (the loader),
> `packages/host/src/skills-boot.ts` (lane boot + listing summary),
> `packages/host/src/skills-cli.ts` (`kubic skills`),
> `apps/kubic/src/prod-runners.ts` (prod wiring).
> Issue [#238](https://github.com/konic-labs/kubic/issues/238).

Skills are markdown documents (`SKILL.md`) the agent can read: reusable
instructions that land on the system prompt as `<skill>` blocks. Discovery
walks fixed roots only — user roots (`~/.pi/agent/skills`,
`~/.agents/skills`, `~/.kubic/skills`), project roots (`.pi/skills` +
`.agents/skills` in the cwd up to the git top level, trusted roots only),
package-declared dirs (the `skills` / `pi.skills` arrays of trusted
`package.json` files), the config `skills` array, and repeatable `--skill`
paths. A skill can still go missing after discovery: the project is
untrusted, the file is unreadable, a package entry escapes its trusted
root, `disable-model-invocation` hides it from the model, or the active
role withholds it. None of that is silent anymore — `kubic skills` names
every skill and why it was left out.

## `kubic skills [--role <name>] [--json]`

Runs the same discovery plus role gating the lane boots (a summary of the
boot, never a reimplementation) and prints one row per skill: name,
source (`user` / `project` / `package` / `settings` / `cli`), path, and
status:

- `visible` — reached the prompt.
- `hidden` — kept off the prompt by its own `disable-model-invocation`
  flag (explicit calls only).
- `withheld` — failed the role/capability gate, with the reason.
- `excluded` — left out by policy: an untrusted project root, or a
  package entry confined away (an absolute path, a `..` escape, or a
  symlink resolving outside the `package.json`'s own directory — refused
  with the reason, never loaded under project trust).
- `error` — the file could not be read, with the reason.

`--role <name>` gates the listing as the lane would for that role (the
document's `skills` allowlist plus the most-restrictive capability merge);
a role that refuses to resolve fails the listing closed with its named
reason. `--json` prints the rows as one stable array (sorted by name).

```
$ kubic skills
NAME    SOURCE   PATH                                  STATUS    REASON
gem     project  /repo/.pi/skills/gem/SKILL.md         excluded  project skills excluded (untrusted project root /repo)
lint    user     /home/u/.agents/skills/lint/SKILL.md  visible
```

## `kubic doctor` and `kubic tui`

`kubic doctor` carries a `skills` line with what the boot met —
`<loaded> loaded, <hidden> hidden, <withheld> withheld, <errors> errors`.
Unreadable skills warn (never fail); per-skill withholds warn beside it
with the gate's reason. See [doctor and debug](doctor-and-debug.md).

`kubic tui` prints a one-time boot notice when the loader skipped
anything (`warning: skills: 2 skipped (1 error, 1 excluded) …`) instead
of dropping the lines — the full reasons live in `kubic skills`.

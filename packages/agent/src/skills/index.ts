// Skills loader. Markdown-only skills from
// own-config + repo only: user roots (~/.pi/agent/skills,
// ~/.agents/skills), project roots (.pi/skills + .agents/skills in the cwd
// up to the git top-level — the cwd alone outside a repository —
// post-trust only, never relabelling a user root as 'project'),
// package-declared skill dirs (`skills` + `pi.skills` in the trusted
// package.json files at or under that same top level), the
// settings array, and repeatable --skill paths (additive even under
// --no-skills). Later sources shadow earlier ones on name conflict.
//
// Safe by construction: there is no fetcher, no installer, no network —
// every skill resolves to a local SKILL.md file. I/O confinement: this
// module never touches node:fs — all reads go through the injected exec
// FileBridge; tests back it with FakeExecutionEnv.
//
// Frontmatter contract (minimal subset, hand-parsed, no deps — Pi parity:
// kebab-case keys, block sequences and folded/literal
// scalars for the contract keys, recursive discovery; deeper YAML —
// anchors, tags, nested maps, indent indicators — reads as plain values):
//   name: string (fallback: directory basename)
//   description: string (fallback: first non-empty body line; `>` folds,
//     `|` keeps newlines)
//   roles: [a, b] or a `- ` block list (absent = visible to every role)
//   tools: [read, write] or a `- ` block list (required tools, gated
//     against the grant)
//   disable-model-invocation: true (hidden from the model XML,
//     explicit-call only — Pi-compatible escape hatch for agent-invoked
//     helpers; the camelCase spelling stays as an alias)

export { discoverSkills } from './discover.js';

export { gateSkills } from './gate.js';
export { projectChain } from './paths.js';
export {
  expandSkillInvocation,
  formatSkillsForSystemPrompt,
} from './prompt.js';
export type {
  DiscoverSkillsOptions,
  LoadedSkill,
  SkillSource,
  SkippedSkill,
  WithheldSkill,
} from './types.js';

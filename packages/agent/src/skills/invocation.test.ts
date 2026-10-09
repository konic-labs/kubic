// Skills loader tests. Faux-only: FakeExecutionEnv + an
// in-test FileBridge adapter (fs access stays inside packages/exec).
import { describe, expect, it } from 'vitest';
import { CWD, HOME, setup, skillMd } from '../test-support/skills-env.js';
import { discoverSkills } from './discover.js';
import { parseSkillFile } from './frontmatter.js';
import {
  expandSkillInvocation,
  formatSkillsForSystemPrompt,
  invokeSkill,
} from './prompt.js';
import type { LoadedSkill } from './types.js';

// Explicit skill paths anchor at the invoking cwd:
// `./rel-skill`, `rel-skill` and `../up/skill` load from cwd-relative
// locations, `rel/SKILL.md` never consults the bridge's own root, and a
// stray filesystem-root hit never wins over the discovery roots.
describe('explicit skill paths anchor at the invoking cwd', () => {
  it('loads --skill ./rel-skill from the cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/rel-skill/SKILL.md`,
      skillMd('name: rel\ndescription: Rel'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['./rel-skill'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['rel']);
    expect(result.skills[0]?.filePath).toBe(`${CWD}/rel-skill/SKILL.md`);
    expect(result.unknownSkills).toEqual([]);
  });

  it('loads a bare --skill name from the cwd when no root provides it', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/local/SKILL.md`,
      skillMd('name: local\ndescription: Local'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['local'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['local']);
    expect(result.unknownSkills).toEqual([]);
  });

  it('prefers the discovery roots over the cwd for a bare name', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/shared/SKILL.md`,
      skillMd('name: shared\ndescription: From root'),
    );
    env.fs.writeFile(
      `${CWD}/shared/SKILL.md`,
      skillMd('name: shared\ndescription: From cwd'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['shared'],
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('From root');
  });

  it('loads --skill ../up/skill above the cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/fakehome/up/skill/SKILL.md',
      skillMd('name: upsy\ndescription: Up'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['../up/skill'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['upsy']);
    expect(result.unknownSkills).toEqual([]);
  });

  it('loads --skill rel/SKILL.md against the cwd, not the bridge root', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/rel/SKILL.md`,
      skillMd('name: relfile\ndescription: Rel file'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['rel/SKILL.md'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['relfile']);
    expect(result.unknownSkills).toEqual([]);
  });

  it('resolves relative settings skill dirs against the cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/team/SKILL.md`,
      skillMd('name: team\ndescription: Team'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      settingsSkills: ['./team'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['team']);
    expect(result.skills[0]?.source).toBe('settings');
  });

  it('never probes the filesystem root for a bare name', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/planted/SKILL.md',
      skillMd('name: planted\ndescription: Planted'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['planted'],
    });
    expect(result.skills).toEqual([]);
    expect(result.unknownSkills).toEqual(['planted']);
  });
});

describe('skill gating and invocation hardening', () => {
  it('escapes XML metacharacters in the system prompt', () => {
    const xml = formatSkillsForSystemPrompt([
      {
        name: 'a&b<c>d"e\'f',
        description: 'x&y<z>"q"',
        filePath: '/p/SKILL.md',
        source: 'user',
        content: 'c',
      },
    ]);
    expect(xml).toContain('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(xml).toContain('x&amp;y&lt;z&gt;&quot;q&quot;');
    expect(xml).not.toContain('a&b');
  });

  it('throws on unknown explicit skill names', () => {
    expect(() => invokeSkill([], 'ghost')).toThrow(/unknown skill/);
  });

  it('expands an explicit invocation to the skill content plus instructions', () => {
    const skills = [
      { name: 'secret', content: 'Hidden content.' },
      { name: 'open', content: 'Open content.' },
    ] as LoadedSkill[];
    expect(expandSkillInvocation(skills, 'secret', 'do x')).toBe(
      'Hidden content.\n\ndo x',
    );
    expect(expandSkillInvocation(skills, 'open')).toBe('Open content.');
    expect(expandSkillInvocation(skills, 'open', '  ')).toBe('Open content.');
    expect(() => expandSkillInvocation(skills, 'ghost', 'do x')).toThrow(
      /unknown skill 'ghost'/,
    );
  });

  it('refuses an unknown skill name with the unknown-skill reason', () => {
    expect(() => expandSkillInvocation([], 'ghost')).toThrow(
      "unknown skill 'ghost'",
    );
  });
});

// Pi skill-contract parity: the canonical kebab-case
// `disable-model-invocation`, block sequences and folded/literal scalars
// for the contract keys, and recursive discovery. Deeper YAML (anchors,
// tags, nested maps, indent indicators) stays plain values by design.
describe('Pi skill-contract parity', () => {
  it('hides disable-model-invocation skills, keeping camelCase as an alias', () => {
    const kebab = parseSkillFile(
      '/x/hide/SKILL.md',
      '---\nname: hide\ndisable-model-invocation: true\n---\nBody.\n',
    );
    expect(kebab.disableModelInvocation).toBe(true);
    const camel = parseSkillFile(
      '/x/hide/SKILL.md',
      '---\nname: hide\ndisableModelInvocation: true\n---\nBody.\n',
    );
    expect(camel.disableModelInvocation).toBe(true);
    const plain = parseSkillFile('/x/hide/SKILL.md', '---\nname: hide\n---\n');
    expect(plain.disableModelInvocation).toBeUndefined();
    // Hidden means hidden: neither spelling reaches the prompt block.
    const xml = formatSkillsForSystemPrompt([
      { ...kebab, source: 'user' },
      { ...camel, name: 'hide2', source: 'user' },
    ]);
    expect(xml).not.toContain('hide');
  });

  it('folds > descriptions and keeps | newlines', () => {
    const folded = parseSkillFile(
      '/x/f/SKILL.md',
      '---\nname: f\ndescription: >\n  Line one\n  line two\n---\nBody.\n',
    );
    expect(folded.description).toBe('Line one line two');
    const literal = parseSkillFile(
      '/x/f/SKILL.md',
      '---\nname: f\ndescription: |\n  Line one\n  line two\n---\nBody.\n',
    );
    expect(literal.description).toBe('Line one\nline two');
    const stripped = parseSkillFile(
      '/x/f/SKILL.md',
      '---\nname: f\ndescription: |-\n  Line one\n  line two\n---\nBody.\n',
    );
    expect(stripped.description).toBe('Line one\nline two');
  });

  it('parses block-list roles and tools, stripping quotes', () => {
    const parsed = parseSkillFile(
      '/x/b/SKILL.md',
      '---\nname: b\nroles:\n  - reviewer\n  - "plan ner"\ntools:\n  - read\n  - write\n---\nBody.\n',
    );
    expect(parsed.roles).toEqual(['reviewer', 'plan ner']);
    expect(parsed.requiredTools).toEqual(['read', 'write']);
  });

  it('reads an empty value with indented non-list text as absent', () => {
    const parsed = parseSkillFile(
      '/x/b/SKILL.md',
      '---\nname: b\nroles:\n  just some text\ntools: [read]\n---\nBody.\n',
    );
    expect(parsed.roles).toBeUndefined();
    expect(parsed.requiredTools).toEqual(['read']);
  });

  it('discovers nested skill dirs, skipping dot-dirs and node_modules', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/outer/nested/SKILL.md`,
      skillMd('name: nested\ndescription: Deep'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/.hidden/SKILL.md`,
      skillMd('name: hidden\ndescription: Nope'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/node_modules/dep/SKILL.md`,
      skillMd('name: dep\ndescription: Nope'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['nested']);
  });
});

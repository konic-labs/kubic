// Prompt template + role preset tests (issue #36; §30). Faux-only:
// FakeExecutionEnv with the same in-test FileBridge adapter as skills.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  discoverTemplates,
  formatPromptTemplateInvocation,
  invokeTemplateAgent,
  invokeTemplateCli,
  invokeTemplateTui,
  loadRolePreset,
  parsePromptTemplate,
  renderPromptTemplate,
} from './templates.js';

function bridgeFromEnv(env: FakeExecutionEnv): FileBridge {
  const isDir = (dir: string, name: string): boolean => {
    const clean = dir.replace(/\/*$/, '');
    const full = clean === '' ? name : `${clean}/${name}`;
    try {
      return env.fs.stat(full).isDirectory;
    } catch {
      return false;
    }
  };
  return {
    cwd: env.cwd,
    absolutePath: (path: string): string => path,
    joinPath: (parts: string[]): string => parts.join('/'),
    readTextFile: (path: string): string => env.fs.readFile(path),
    readBinaryFile: (path: string): Uint8Array =>
      new TextEncoder().encode(env.fs.readFile(path)),
    readTextLines: (path: string, maxLines?: number): string[] => {
      const lines = env.fs.readFile(path).split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return maxLines === undefined ? lines : lines.slice(0, maxLines);
    },
    openTextLineReader: (path: string) => {
      const reader = bridgeFromEnv(env);
      const lines = reader.readTextLines(path);
      let index = 0;
      return {
        readLine: (): string | undefined =>
          index < lines.length ? lines[index++] : undefined,
        close: (): void => undefined,
      };
    },
    writeFile: (path: string, content: string | Uint8Array): void => {
      env.fs.writeFile(path, typeof content === 'string' ? content : '{}');
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      const prior = (() => {
        try {
          return env.fs.readFile(path);
        } catch {
          return '';
        }
      })();
      env.fs.writeFile(
        path,
        prior + (typeof content === 'string' ? content : '{}'),
      );
    },
    renameFile: (source: string, destination: string): void => {
      env.fs.rename(source, destination);
    },
    fileInfo: (path: string) => ({
      name: path.split('/').pop() ?? path,
      path,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mtimeMs: 0,
    }),
    listDir: (path: string) =>
      env.fs.listDir(path).map((name) => ({
        name,
        path: `${path.replace(/\/*$/, '')}/${name}`,
        isDirectory: isDir(path, name),
        isSymbolicLink: false,
        size: 0,
        mtimeMs: 0,
      })),
    exists: (path: string): boolean => {
      try {
        env.fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    createDir: (): void => undefined,
    remove: (): void => undefined,
    createTempDir: (): string => '/fake-tmp',
    createTempFile: (): string => '/fake-tmp-file',
  };
}

const PLAN_MD = `---
name: plan
description: Plan the work
args: [{name: task, required: true}, {name: scope, default: "whole repo"}]
---
# Plan for {{task}}

Scope: {{scope}}.
`;

function setup(): { env: FakeExecutionEnv; bridge: FileBridge } {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('/tpl/plan.md', PLAN_MD);
  return { env, bridge: bridgeFromEnv(env) };
}

describe('prompt templates (issue #36)', () => {
  it('parses name/description/args from template frontmatter', () => {
    const template = parsePromptTemplate('/tpl/plan.md', PLAN_MD);
    expect(template.name).toBe('plan');
    expect(template.description).toBe('Plan the work');
    expect(template.args).toEqual([
      { name: 'task', required: true },
      { name: 'scope', required: false, default: 'whole repo' },
    ]);
  });

  it('discovers templates from template dirs', () => {
    const { bridge } = setup();
    const found = discoverTemplates(bridge, ['/tpl']);
    expect(found.map((template) => template.name)).toEqual(['plan']);
  });

  it('renders args and rejects missing required args', () => {
    const template = parsePromptTemplate('/tpl/plan.md', PLAN_MD);
    expect(renderPromptTemplate(template, { task: 'auth' })).toContain(
      '# Plan for auth',
    );
    expect(renderPromptTemplate(template, { task: 'auth' })).toContain(
      'Scope: whole repo.',
    );
    expect(() => renderPromptTemplate(template, {})).toThrow(
      /template 'plan' needs argument 'task'/,
    );
  });

  it('formats a template invocation for the prompt', () => {
    const template = parsePromptTemplate('/tpl/plan.md', PLAN_MD);
    const formatted = formatPromptTemplateInvocation(template, {
      task: 'auth',
    });
    expect(formatted).toContain('plan');
    expect(formatted).toContain('# Plan for auth');
  });

  it('is callable from the CLI surface', () => {
    const { bridge } = setup();
    const templates = discoverTemplates(bridge, ['/tpl']);
    const lines: string[] = [];
    const code = invokeTemplateCli(
      'plan',
      { task: 'auth' },
      {
        templates,
        out: (line: string): void => {
          lines.push(line);
        },
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('# Plan for auth');
    const missing = invokeTemplateCli(
      'ghost',
      {},
      {
        templates,
        out: (line: string): void => {
          lines.push(line);
        },
      },
    );
    expect(missing).toBe(1);
    expect(lines.join('\n')).toContain("unknown template 'ghost'");
  });

  it('is callable from the TUI surface', () => {
    const { bridge } = setup();
    const templates = discoverTemplates(bridge, ['/tpl']);
    const view = invokeTemplateTui('plan', { task: 'auth' }, { templates });
    expect(view.title).toBe('plan');
    expect(view.body).toContain('# Plan for auth');
    const failed = invokeTemplateTui('plan', {}, { templates });
    expect(failed.error).toMatch(/needs argument 'task'/);
  });

  it('is callable from the agent surface', () => {
    const { bridge } = setup();
    const templates = discoverTemplates(bridge, ['/tpl']);
    const prompt = invokeTemplateAgent(
      'plan',
      { task: 'auth' },
      {
        templates,
      },
    );
    expect(prompt).toContain('# Plan for auth');
    expect(() => invokeTemplateAgent('ghost', {}, { templates })).toThrow(
      /unknown template 'ghost'/,
    );
  });
});

describe('role presets as files (issue #36)', () => {
  function presetSetup(): { bridge: FileBridge } {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile(
      '/roles/reviewer.md',
      `---
name: reviewer
description: Review-only preset
args: [{name: target, required: true}]
grants: {filesystem: read, shell: false, network: none, git: workspace, credentials: none}
---
You review {{target}}.
`,
    );
    env.fs.writeFile(
      '/roles/implementer.md',
      `---
name: implementer
description: Implementer preset
args: [{name: target, required: true}]
grants: {filesystem: workspace-write, shell: true, network: none, git: workspace, credentials: none}
---
You implement {{target}}.
`,
    );
    return { bridge: bridgeFromEnv(env) };
  }

  it('loads the reviewer preset as template + grant', () => {
    const { bridge } = presetSetup();
    const preset = loadRolePreset(bridge, '/roles', 'reviewer');
    expect(preset.template.name).toBe('reviewer');
    expect(
      renderPromptTemplate(preset.template, { target: 'PR 12' }),
    ).toContain('You review PR 12.');
    expect(preset.grants).toMatchObject({
      filesystem: 'read',
      shell: false,
    });
  });

  it('loads the implementer preset as template + grant', () => {
    const { bridge } = presetSetup();
    const preset = loadRolePreset(bridge, '/roles', 'implementer');
    expect(preset.template.name).toBe('implementer');
    expect(preset.grants).toMatchObject({
      filesystem: 'workspace-write',
      shell: true,
    });
  });

  it('rejects presets with invalid grants', () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile(
      '/roles/broken.md',
      '---\nname: broken\ngrants: {filesystem: everything}\n---\nHi.\n',
    );
    expect(() =>
      loadRolePreset(bridgeFromEnv(env), '/roles', 'broken'),
    ).toThrow(/filesystem/i);
  });
});

// Template frontmatter + surface hardening (issue #69): quote styles,
// malformed args, and unreadable-file branches pinned.
describe('template frontmatter hardening (issue #69)', () => {
  it('parses single-quoted scalars', () => {
    const template = parsePromptTemplate(
      '/tpl/q.md',
      "---\nname: 'quoted'\ndescription: 'It works'\n---\nHi.\n",
    );
    expect(template.name).toBe('quoted');
    expect(template.description).toBe('It works');
  });

  it('falls back to the file basename without .md', () => {
    const template = parsePromptTemplate('/tpl/noname.md', 'Just a body.\n');
    expect(template.name).toBe('noname');
    expect(template.args).toEqual([]);
    expect(template.description).toBeUndefined();
  });

  it('keeps unclosed frontmatter as raw content', () => {
    const raw = '---\nname: x\nNo closing fence.\n';
    const template = parsePromptTemplate('/tpl/raw.md', raw);
    expect(template.content).toBe(raw);
    expect(template.args).toEqual([]);
  });

  it('parses CRLF frontmatter', () => {
    const template = parsePromptTemplate(
      '/tpl/cr.md',
      '---\r\nname: crlf\r\n---\r\nBody\r\n',
    );
    expect(template.name).toBe('crlf');
  });

  it('rejects non-list args and unnamed args', () => {
    expect(() =>
      parsePromptTemplate('/tpl/bad.md', '---\nargs: nope\n---\nHi.\n'),
    ).toThrow(/non-list 'args'/);
    expect(() =>
      parsePromptTemplate(
        '/tpl/bad.md',
        '---\nargs: [{required: true}]\n---\nHi.\n',
      ),
    ).toThrow(/without a name/);
  });

  it('parses string-entry args and flow maps with descriptions', () => {
    const template = parsePromptTemplate(
      '/tpl/mixed.md',
      '---\nargs: [topic, {name: depth, default: "shallow", description: "How deep"}]\n---\n{{topic}} {{depth}}.\n',
    );
    expect(template.args).toEqual([
      { name: 'topic', required: false },
      {
        name: 'depth',
        required: false,
        default: 'shallow',
        description: 'How deep',
      },
    ]);
    expect(renderPromptTemplate(template, { topic: 'x' })).toContain(
      'x shallow.',
    );
  });

  it('renders optional arg defaults and blanks', () => {
    const template = parsePromptTemplate(
      '/tpl/opt.md',
      '---\nargs: [{name: a}, {name: b, default: "d"}]\n---\n[{{a}}|{{b}}] {{missing}}.\n',
    );
    expect(renderPromptTemplate(template, {})).toBe('[|d] {{missing}}.\n');
  });

  it('skips comment and colon-less frontmatter lines', () => {
    const template = parsePromptTemplate(
      '/tpl/c.md',
      '---\n# comment\nno-colon\nname: kept\n---\nHi.\n',
    );
    expect(template.name).toBe('kept');
  });

  it('pins the exact invocation block shape', () => {
    const template = parsePromptTemplate('/tpl/plan.md', PLAN_MD);
    expect(formatPromptTemplateInvocation(template, { task: 'auth' })).toBe(
      '<prompt-template name="plan">\n# Plan for auth\n\nScope: whole repo.\n\n</prompt-template>',
    );
  });
});

describe('template discovery and preset hardening (issue #69)', () => {
  it('skips missing dirs and non-markdown files, sorts by name', () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('/tpl/b.md', 'B body.\n');
    env.fs.writeFile('/tpl/a.md', 'A body.\n');
    env.fs.writeFile('/tpl/notes.txt', 'Not a template.\n');
    const found = discoverTemplates(bridgeFromEnv(env), ['/missing', '/tpl']);
    expect(found.map((template) => template.name)).toEqual(['a', 'b']);
  });

  it('logs unreadable templates and keeps the readable ones', () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('/tpl/ok.md', 'Ok body.\n');
    const bridge = bridgeFromEnv(env);
    const throwing: FileBridge = {
      ...bridge,
      readTextFile: (path: string): string => {
        if (path.endsWith('bad.md')) throw new Error('EACCES');
        return bridge.readTextFile(path);
      },
      listDir: () => [
        {
          name: 'ok.md',
          path: '/tpl/ok.md',
          isDirectory: false,
          isSymbolicLink: false,
          size: 0,
          mtimeMs: 0,
        },
        {
          name: 'bad.md',
          path: '/tpl/bad.md',
          isDirectory: false,
          isSymbolicLink: false,
          size: 0,
          mtimeMs: 0,
        },
      ],
    };
    const lines: string[] = [];
    const found = discoverTemplates(throwing, ['/tpl'], (line) => {
      lines.push(line);
    });
    expect(found.map((template) => template.name)).toEqual(['ok']);
    expect(lines.some((line) => /unreadable \/tpl\/bad\.md/.test(line))).toBe(
      true,
    );
  });

  it('throws on unknown role presets', () => {
    const env = new FakeExecutionEnv({});
    expect(() => loadRolePreset(bridgeFromEnv(env), '/roles', 'ghost')).toThrow(
      /unknown role preset/,
    );
  });

  it('loads presets without grants over the solo defaults', () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('/roles/plain.md', '---\nname: plain\n---\nHi {{x}}.\n');
    const preset = loadRolePreset(bridgeFromEnv(env), '/roles', 'plain');
    expect(preset.template.name).toBe('plain');
    expect(typeof preset.grants.filesystem).toBe('string');
  });

  it('reports TUI failures with the template name and empty body', () => {
    const { bridge } = setup();
    const templates = discoverTemplates(bridge, ['/tpl']);
    const view = invokeTemplateTui('ghost', {}, { templates });
    expect(view).toMatchObject({ title: 'ghost', body: '' });
    expect(view.error).toMatch(/unknown template/);
  });

  it('stringifies non-Error failures on the CLI surface', () => {
    const lines: string[] = [];
    const code = invokeTemplateCli(
      'ghost',
      {},
      {
        templates: [],
        out: (line: string): void => {
          lines.push(line);
        },
      },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/^error: unknown template/);
  });
});

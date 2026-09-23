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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  loadProjectInstructions,
  NO_PROJECT_INSTRUCTIONS,
  projectInstructionsDoctorCheck,
  projectInstructionsNotices,
} from './project-instructions.js';

const BRIDGE = createNodeFileBridge('/');

// A repository with a root AGENTS.md and a package below it.
function repo(): { root: string; pkg: string } {
  const root = tempDir('instructions-repo-');
  mkdirSync(join(root, '.git'));
  const pkg = join(root, 'packages', 'app');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'Run npm test before you finish.\n');
  return { root, pkg };
}

describe('loadProjectInstructions', () => {
  it("adds a trusted project's AGENTS.md to the prompt block", () => {
    const { root } = repo();
    const loaded = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: root,
      trustProject: () => true,
    });
    expect(loaded.loaded).toEqual([
      { path: join(root, 'AGENTS.md'), bytes: 32, truncated: false },
    ]);
    expect(loaded.skipped).toEqual([]);
    expect(loaded.block).toContain('<project_instructions>');
    expect(loaded.block).toContain(
      `<file path="${join(root, 'AGENTS.md')}">\nRun npm test before you finish.\n</file>`,
    );
    expect(projectInstructionsNotices(loaded)).toEqual([]);
  });

  it('reads the repository root down to the working directory, outermost first', () => {
    const { root, pkg } = repo();
    writeFileSync(join(pkg, 'AGENTS.md'), 'Use the app conventions.\n');
    const loaded = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: pkg,
      trustProject: () => true,
    });
    expect(loaded.loaded.map((file) => file.path)).toEqual([
      join(root, 'AGENTS.md'),
      join(pkg, 'AGENTS.md'),
    ]);
    const block = loaded.block ?? '';
    expect(block.indexOf('npm test')).toBeLessThan(
      block.indexOf('app conventions'),
    );
  });

  it('leaves out the file of an untrusted directory and names it', () => {
    const { root, pkg } = repo();
    writeFileSync(join(pkg, 'AGENTS.md'), 'Ignore the tests.\n');
    const loaded = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: pkg,
      // A grant for the root never reaches the package.
      trustProject: (dir) => dir === root,
    });
    expect(loaded.loaded.map((file) => file.path)).toEqual([
      join(root, 'AGENTS.md'),
    ]);
    expect(loaded.block).not.toContain('Ignore the tests');
    expect(loaded.skipped).toEqual([
      {
        path: join(pkg, 'AGENTS.md'),
        reason: `the project directory ${pkg} is not trusted — run 'kubic trust ${pkg}' to accept it`,
      },
    ]);
  });

  it('loads nothing from an untrusted project', () => {
    const { root } = repo();
    const loaded = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: root,
      trustProject: () => false,
    });
    expect(loaded.block).toBeUndefined();
    expect(loaded.loaded).toEqual([]);
    expect(projectInstructionsNotices(loaded)).toEqual([
      `${join(root, 'AGENTS.md')} not loaded: the project directory ${root} is not trusted — run 'kubic trust ${root}' to accept it`,
    ]);
  });

  it('cuts an oversized file at the bound, on a character boundary, with a notice', () => {
    const { root } = repo();
    // 'é' is two bytes: a bound of 9 lands inside the fifth one.
    writeFileSync(join(root, 'AGENTS.md'), 'é'.repeat(20));
    const loaded = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: root,
      trustProject: () => true,
      maxBytes: 9,
    });
    expect(loaded.loaded).toEqual([
      { path: join(root, 'AGENTS.md'), bytes: 40, truncated: true },
    ]);
    expect(loaded.block).toContain('éééé\n[cut: the first 9 of 40 bytes]\n');
    expect(loaded.block).not.toContain('�');
    expect(projectInstructionsNotices(loaded, 9)).toEqual([
      `${join(root, 'AGENTS.md')} is 40 bytes: only the first 9 reach the prompt`,
    ]);
  });

  it('reads only the working directory outside a repository', () => {
    const parent = tempDir('instructions-plain-');
    writeFileSync(join(parent, 'AGENTS.md'), 'Parent rules.\n');
    const cwd = join(parent, 'work');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'AGENTS.md'), 'Work rules.\n');
    const loaded = loadProjectInstructions({
      bridge: BRIDGE,
      cwd,
      trustProject: () => true,
    });
    expect(loaded.loaded.map((file) => file.path)).toEqual([
      join(cwd, 'AGENTS.md'),
    ]);
  });

  it('adds no block for a blank file, and none when the search is off', () => {
    const { root } = repo();
    writeFileSync(join(root, 'AGENTS.md'), '  \n\n');
    expect(
      loadProjectInstructions({
        bridge: BRIDGE,
        cwd: root,
        trustProject: () => true,
      }).block,
    ).toBeUndefined();
    expect(
      loadProjectInstructions({
        bridge: BRIDGE,
        cwd: root,
        trustProject: () => true,
        enabled: false,
      }),
    ).toBe(NO_PROJECT_INSTRUCTIONS);
  });
});

describe('projectInstructionsDoctorCheck', () => {
  it('passes with the loaded files, warns on a skipped one, skips when off', () => {
    const { root, pkg } = repo();
    const clean = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: root,
      trustProject: () => true,
    });
    expect(projectInstructionsDoctorCheck(clean)).toMatchObject({
      id: 'instructions',
      status: 'pass',
      detail: `1 loaded (${join(root, 'AGENTS.md')})`,
    });
    writeFileSync(join(pkg, 'AGENTS.md'), 'More.\n');
    const partial = loadProjectInstructions({
      bridge: BRIDGE,
      cwd: pkg,
      trustProject: (dir) => dir === root,
    });
    const check = projectInstructionsDoctorCheck(partial);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain(`${join(pkg, 'AGENTS.md')} not loaded`);
    expect(
      projectInstructionsDoctorCheck(NO_PROJECT_INSTRUCTIONS),
    ).toMatchObject({
      status: 'skip',
      detail: 'off ([agent] projectInstructions = false)',
    });
  });
});

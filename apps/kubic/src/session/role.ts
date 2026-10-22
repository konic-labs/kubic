// The boot's role step: `--role` resolved to its document, prompt and tool
// set, or refused by name.

import { homedir } from 'node:os';
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { findProjectRoot } from '@kubic/host/cli';
import { rolePromptFor, selectRole } from '@kubic/host/roles';
import type { BootRefusal, BootRole, SessionBoot } from './bootstrap.js';

// `--role` loads the role document and derives the prompt text, the tool
// allowlist and the model default from it. The refusals are fail-closed
// with a named reason: an unknown role, a contradictory document, a
// document with no instructions, and a parse failure. An absent --role
// leaves the lane boot unchanged.
export function resolveBootRole(
  boot: SessionBoot,
): BootRole | BootRefusal | undefined {
  const { role } = boot.request;
  const policy = boot.config.modelPolicy;
  if (role === undefined) {
    // The stock run resolves no role document — the [policy] line still
    // names the default role it runs as.
    boot.sinks.debug?.(`[policy] role=${DEFAULT_RUN_ROLE} (default)`);
    return undefined;
  }
  const roles = boot.config.roles;
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
    boot.sinks.debug?.(
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

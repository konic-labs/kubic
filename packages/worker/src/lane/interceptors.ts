// Policy interceptors on the solo lane (issue #15, slice C; §40.1 mechanism 3).
// Registered as separate harness hooks so chaining, first-block-wins, and
// throw-becomes-block are the harness's real semantics, not ours. Every
// handler is fail-closed: a policy exception blocks with its message.
import { isAbsolute, join, resolve } from 'node:path';
import type { Hooks } from '../pi-boundary.js';

export interface PolicyTrigger {
  kind: 'max_tool_calls';
  toolName: string;
  count: number;
}

export interface PolicyInterceptorOptions {
  workspace: string;
  maxToolCalls?: number;
  onTrigger?: (trigger: PolicyTrigger) => void;
  isDestructive?: (command: string) => boolean;
}

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+[^|;&]*-[a-zA-Z]*r/i,
  /\bmkfs\b/i,
  /\bdd\b[^|;&]*\bof=\s*\/dev\//i,
];

export function defaultIsDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export function confinePath(
  workspace: string,
  path: string,
): { confined: string; rewritten: boolean } {
  const root = resolve(workspace);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (resolved === root || resolved.startsWith(`${root}/`))
    return { confined: resolved, rewritten: false };
  const tail = resolved
    .split('/')
    .filter((part) => part !== '' && part !== '..' && part !== '.');
  return { confined: join(root, tail.join('/')), rewritten: true };
}

function block(reason: string): {
  block: { reason: string; terminate: false };
} {
  return { block: { reason, terminate: false as const } };
}

function failClosed<T>(
  fn: () => T | Promise<T>,
): Promise<T | { block: { reason: string; terminate: false } }> {
  try {
    const value = fn();
    return value instanceof Promise
      ? value.catch((error: unknown) =>
          block(error instanceof Error ? error.message : String(error)),
        )
      : Promise.resolve(value);
  } catch (error: unknown) {
    return Promise.resolve(
      block(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function registerPolicyInterceptors(
  hooks: Hooks,
  options: PolicyInterceptorOptions,
): () => void {
  const isDestructive = options.isDestructive ?? defaultIsDestructive;
  let calls = 0;
  let triggered = false;
  const off: Array<() => void> = [];

  off.push(
    hooks.on('before_tool', (event) =>
      failClosed(() => {
        if (event.toolName !== 'bash') return undefined;
        const command =
          typeof event.args['command'] === 'string'
            ? event.args['command']
            : '';
        if (isDestructive(command)) {
          return block(`destructive command blocked: ${command}`);
        }
        return undefined;
      }),
    ),
  );

  off.push(
    hooks.on('before_tool', (event) =>
      failClosed(() => {
        if (event.toolName !== 'read') return undefined;
        const path = event.args['path'];
        if (typeof path !== 'string') return undefined;
        const { confined, rewritten } = confinePath(options.workspace, path);
        if (!rewritten) return undefined;
        return { args: { ...event.args, path: confined } };
      }),
    ),
  );

  if (options.maxToolCalls !== undefined) {
    const max = options.maxToolCalls;
    off.push(
      hooks.on('before_tool', (event) =>
        failClosed(() => {
          calls += 1;
          if (calls <= max) return undefined;
          if (!triggered) {
            triggered = true;
            options.onTrigger?.({
              kind: 'max_tool_calls',
              toolName: event.toolName,
              count: calls,
            });
          }
          return block(`maxToolCalls (${max}) exceeded`);
        }),
      ),
    );
  }

  return () => {
    for (const remove of off) remove();
  };
}

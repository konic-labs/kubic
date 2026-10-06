// The Kubic keybinding registry (issue #303; §16.6 "never hardcode key
// strings", §16.9 "KeybindingsManager tracks definitions, conflicts, and user
// overrides"). Every key the app claims ahead of the editor — the global
// toggles, the open panel's navigation and the approval decisions — is an
// ACTION here with its default keys; the input path asks the registry which
// action a key id is bound to, so a user override in
// `~/.kubic/keybindings.json` rebinds the action everywhere at once (the
// dispatch, the key hints, the approval surface).
//
// Pi's own KeybindingsManager is not used: the tui seam exposes no registry
// writer and Pi's ids name the editor's actions, not Kubic's. This module is
// pure (no fs): the composition root reads the file and hands the text in.

import {
  APPROVAL_DEFAULT_KEYS,
  APPROVAL_PAGE_KEY,
  type ApprovalKeyOverrides,
} from './approval-view.js';

/**
 * Where a binding acts. `global` and `panel` keys are both live while the
 * editor has focus (the panel pair only while a panel is open), so they share
 * one conflict space; `approval` keys act only while an approval shows, and
 * the approval owns the keys first, so they conflict only with each other.
 */
export type KeyScope = 'global' | 'panel' | 'approval';

interface ActionSpec {
  readonly scope: KeyScope;
  readonly keys: readonly string[];
  readonly description: string;
}

export const KEY_ACTIONS = {
  'app.interrupt': {
    scope: 'global',
    keys: ['ctrl+c'],
    description:
      'interrupt the running turn; idle: clear the draft, then press twice to quit',
  },
  // Issue #454: Esc never quits. It closes what is open, interrupts a
  // running turn, and (idle, empty editor) enters block mode.
  'app.cancel': {
    scope: 'global',
    keys: ['escape'],
    description:
      'close the open dropdown or overlay; else interrupt the running turn',
  },
  // Issue #454: unbound by default (Esc used to quit); still bindable.
  'app.exit': {
    scope: 'global',
    keys: [],
    description: 'quit on an empty draft (clears a draft first)',
  },
  'app.eof': {
    scope: 'global',
    keys: ['ctrl+d'],
    description: 'quit on an empty draft; delete-forward while typing',
  },
  'app.palette': {
    scope: 'global',
    keys: ['ctrl+p'],
    description: 'open the command palette',
  },
  'session.mode': {
    scope: 'global',
    keys: ['ctrl+g'],
    description: 'switch solo / orchestrator between turns',
  },
  'view.tree': {
    scope: 'global',
    keys: ['ctrl+t'],
    description: 'toggle the tree',
  },
  'panel.diff': {
    scope: 'global',
    keys: ['ctrl+o'],
    description: 'toggle the diff panel',
  },
  'panel.journal': {
    scope: 'global',
    keys: ['ctrl+r'],
    description: 'toggle the journal panel',
  },
  'transcript.expand': {
    scope: 'global',
    keys: ['ctrl+x'],
    description: 'expand / collapse tool output',
  },
  'prompt.steer': {
    scope: 'global',
    keys: ['alt+enter'],
    description: 'steer the running turn (submit when idle)',
  },
  'model.pick': {
    scope: 'global',
    keys: ['alt+m'],
    description: 'open the model picker',
  },
  'model.thinking': {
    scope: 'global',
    keys: ['alt+t'],
    description: 'cycle the thinking level',
  },
  'approvals.fullAccess': {
    scope: 'global',
    keys: ['alt+a'],
    description: 'toggle full access for this session',
  },
  'panel.next': {
    scope: 'panel',
    keys: ['alt+down'],
    description: 'open panel: next file (diff) / next page (journal)',
  },
  'panel.previous': {
    scope: 'panel',
    keys: ['alt+up'],
    description: 'open panel: previous file (diff) / previous page (journal)',
  },
  'approval.allowOnce': {
    scope: 'approval',
    keys: APPROVAL_DEFAULT_KEYS['allow-once'],
    description: 'approval: allow once',
  },
  'approval.allowSession': {
    scope: 'approval',
    keys: APPROVAL_DEFAULT_KEYS['allow-session'],
    description: 'approval: allow for the session',
  },
  'approval.deny': {
    scope: 'approval',
    keys: APPROVAL_DEFAULT_KEYS.deny,
    description: 'approval: deny',
  },
  'approval.page': {
    scope: 'approval',
    keys: [APPROVAL_PAGE_KEY],
    description: 'approval: next page of a long command',
  },
} as const satisfies Record<string, ActionSpec>;

export type KeyAction = keyof typeof KEY_ACTIONS;

export const KEY_ACTION_IDS: ReadonlyArray<KeyAction> = Object.keys(
  KEY_ACTIONS,
) as KeyAction[];

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'super'] as const;
const NAMED_KEYS = new Set([
  'escape',
  'enter',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
]);

/** A key id is invalid in the keybindings file (named in the message). */
export class KeybindingsError extends Error {
  override readonly name = 'KeybindingsError';
}

/**
 * One spelling per key: modifiers in a fixed order, lower-case. pi-tui's
 * parseKey is not order-stable (`\x1b[102;6u` parses to `shift+ctrl+f`), so
 * both the registry's keys and every parsed key id go through this before
 * they are compared. `undefined` for a malformed id.
 */
export function canonicalKey(id: string): string | undefined {
  const parts = id.trim().toLowerCase().split('+');
  const key = parts.pop();
  if (key === undefined) return undefined;
  const name = key;
  const isFunctionKey = /^f([1-9]|1[0-2])$/.test(name);
  if (!(NAMED_KEYS.has(name) || isFunctionKey || [...name].length === 1)) {
    return undefined;
  }
  const modifiers = new Set<string>();
  for (const part of parts) {
    if (!(MODIFIER_ORDER as readonly string[]).includes(part)) return undefined;
    if (modifiers.has(part)) return undefined;
    modifiers.add(part);
  }
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, name].join('+');
}

/** What the file may say: an action id → one key id or a list (replaces the defaults). */
export type KeybindingOverrides = Partial<Record<KeyAction, readonly string[]>>;

/**
 * Parse `~/.kubic/keybindings.json`. An object of `action: "key"` or
 * `action: ["key", ...]`; an empty list unbinds the action. Unknown actions,
 * malformed key ids and non-JSON text are refused by name — a typo'd
 * binding must never silently leave the default in place.
 */
export function parseKeybindingsJson(
  text: string,
  source: string,
): KeybindingOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new KeybindingsError(
      `keybindings '${source}': invalid JSON (${detail})`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KeybindingsError(
      `keybindings '${source}': expected an object of action → key`,
    );
  }
  const overrides: Record<string, readonly string[]> = {};
  for (const [action, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!Object.hasOwn(KEY_ACTIONS, action)) {
      throw new KeybindingsError(
        `keybindings '${source}': unknown action '${action}' (known: ${KEY_ACTION_IDS.join(', ')})`,
      );
    }
    const list =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value) && value.every((k) => typeof k === 'string')
          ? (value as string[])
          : undefined;
    if (list === undefined) {
      throw new KeybindingsError(
        `keybindings '${source}': '${action}' must be a key id or a list of key ids`,
      );
    }
    const keys: string[] = [];
    for (const key of list) {
      const canonical = canonicalKey(key);
      if (canonical === undefined) {
        throw new KeybindingsError(
          `keybindings '${source}': '${action}' has an invalid key id '${key}'`,
        );
      }
      keys.push(canonical);
    }
    overrides[action] = keys;
  }
  return overrides as KeybindingOverrides;
}

export interface KeyRegistry {
  /** The keys an action is bound to after overrides (canonical ids). */
  keysFor(action: KeyAction): readonly string[];
  /** The action a key id triggers in a scope (`global` also covers `panel`). */
  actionFor(scope: KeyScope, keyId: string | undefined): KeyAction | undefined;
  /** Every key the app claims ahead of the editor (global scope only). */
  isGlobalKey(keyId: string | undefined): boolean;
  /** Those keys as a list (the approval surface refuses to shadow them). */
  globalKeys(): readonly string[];
  /** The first bound key, for hints (`'esc'` for escape); '' when unbound. */
  label(action: KeyAction): string;
  /** The approval surface's bindings, in its own action vocabulary. */
  approvalOverrides(): ApprovalKeyOverrides;
  /** Conflicts and displaced defaults found while resolving the overrides. */
  readonly notices: readonly string[];
}

const conflictSpace = (scope: KeyScope): 'editor' | 'approval' =>
  scope === 'approval' ? 'approval' : 'editor';

/**
 * Resolve the defaults with the user's overrides. A user binding beats a
 * default: the default action loses that key (and is reported, and reported
 * as unbound if nothing is left). Two user bindings on one key in the same
 * conflict space are a conflict: the first in registry order keeps it, the
 * other loses it, and both are named — reported at boot, never silent.
 */
export function createKeyRegistry(
  overrides: KeybindingOverrides = {},
): KeyRegistry {
  const notices: string[] = [];
  const bound = new Map<KeyAction, string[]>();
  const overridden = new Set<KeyAction>();
  for (const action of KEY_ACTION_IDS) {
    const user = overrides[action];
    if (user !== undefined) overridden.add(action);
    const keys = (user ?? KEY_ACTIONS[action].keys).map(
      (key) => canonicalKey(key) ?? key,
    );
    bound.set(action, [...new Set(keys)]);
  }
  // One owner per (conflict space, key): overrides first, then defaults.
  const owner = new Map<string, KeyAction>();
  const order = [
    ...KEY_ACTION_IDS.filter((a) => overridden.has(a)),
    ...KEY_ACTION_IDS.filter((a) => !overridden.has(a)),
  ];
  for (const action of order) {
    const space = conflictSpace(KEY_ACTIONS[action].scope);
    const kept: string[] = [];
    for (const key of bound.get(action) ?? []) {
      const slot = `${space}:${key}`;
      const holder = owner.get(slot);
      if (holder === undefined) {
        owner.set(slot, action);
        kept.push(key);
        continue;
      }
      if (overridden.has(action)) {
        notices.push(
          `keybinding conflict: ${key} is bound to both ${holder} and ${action} — ${holder} keeps it`,
        );
      } else {
        notices.push(
          `keybinding: ${key} now runs ${holder} (override), so ${action} no longer has it`,
        );
      }
    }
    bound.set(action, kept);
    if (kept.length === 0 && KEY_ACTIONS[action].keys.length > 0) {
      notices.push(`keybinding: ${action} is unbound`);
    }
  }
  const lookup = (space: 'editor' | 'approval', keyId: string | undefined) => {
    if (keyId === undefined) return undefined;
    const canonical = canonicalKey(keyId);
    return canonical === undefined
      ? undefined
      : owner.get(`${space}:${canonical}`);
  };
  return {
    keysFor: (action) => bound.get(action) ?? [],
    actionFor: (scope, keyId) => {
      const action = lookup(conflictSpace(scope), keyId);
      if (action === undefined) return undefined;
      const actual = KEY_ACTIONS[action].scope;
      if (scope === 'approval') return action;
      return actual === 'approval' ? undefined : action;
    },
    isGlobalKey: (keyId) => {
      const action = lookup('editor', keyId);
      return action !== undefined && KEY_ACTIONS[action].scope === 'global';
    },
    globalKeys: () =>
      KEY_ACTION_IDS.filter(
        (action) => KEY_ACTIONS[action].scope === 'global',
      ).flatMap((action) => bound.get(action) ?? []),
    label: (action) => {
      const key = bound.get(action)?.[0];
      return key === undefined ? '' : key === 'escape' ? 'esc' : key;
    },
    approvalOverrides: () =>
      ({
        'allow-once': bound.get('approval.allowOnce') ?? [],
        'allow-session': bound.get('approval.allowSession') ?? [],
        deny: bound.get('approval.deny') ?? [],
      }) as ApprovalKeyOverrides,
    notices,
  };
}

/** The shipped bindings, no overrides. */
export const DEFAULT_KEY_REGISTRY: KeyRegistry = createKeyRegistry();

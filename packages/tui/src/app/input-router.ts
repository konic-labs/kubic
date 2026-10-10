// The app's input routing: one table of routes in precedence order. Each
// route looks at the key and either answers it or passes it on; the editor
// takes whatever no route claimed.
//
// The global keys are classified by pi-tui's own `parseKey`, never by
// comparing raw bytes: a Kitty-class terminal negotiates the keyboard
// protocol and sends CSI-u sequences — Esc arrives as '\x1b[27u', Ctrl-D as
// '\x1b[100;5u', Ctrl-C as '\x1b[27;5;99~' — so a `data === '\x1b'` test
// silently misses them and the key becomes a no-op. The legacy byte forms
// ('\x03', '\x1b', '\x04', '\x14') parse to the same ids, so nothing is lost
// for terminals that do not negotiate the protocol.
import { keyCap } from '../chrome.js';
import type { KeyAction } from '../keybindings.js';
import { isKeyRelease, isKeyRepeat, parseKey } from '../tui-boundary.js';
import type { AppCore } from './core.js';
import type { TuiInputResult } from './types.js';

interface KeyInput {
  readonly data: string;
  readonly keyId: string | undefined;
  // The global action the key is bound to, if any.
  readonly action: KeyAction | undefined;
}

interface InputRoute {
  readonly name: string;
  // The route's answer, or undefined to pass the key on.
  run(core: AppCore, input: KeyInput): TuiInputResult | undefined;
}

const consumed = (): TuiInputResult => ({
  quit: false,
  consumed: true,
  cancel: false,
});

const isCancelKey = (action: KeyAction | undefined): boolean =>
  action === 'app.cancel' ||
  action === 'app.exit' ||
  action === 'app.interrupt';

// The routes, in precedence order.
/** @internal */
export const INPUT_ROUTES: readonly InputRoute[] = [
  // A Kitty-class terminal reports key releases (and repeats) as their own
  // events, and this router runs before pi-tui's focused-path release
  // filter. A release is never an action: dropping it here — before
  // approval decide, the global keys and the editor — keeps toggles from
  // cancelling themselves on key-up and a Ctrl-C cancel or an Esc deny from
  // turning into a quit.
  {
    name: 'release',
    run: (_core, { data }) => (isKeyRelease(data) ? consumed() : undefined),
  },
  // A held key's repeats reach the draft (held backspace keeps deleting) but
  // never the approval decision keys or a global key — a held Ctrl-O must not
  // strobe the panel, and a held allow key must not answer the NEXT request
  // too. A dropped repeat is still typing — it never reaches decide(), so
  // the surface is told to restart its arming window.
  {
    name: 'repeat',
    run: (core, { data, keyId }) => {
      if (!isKeyRepeat(data)) return undefined;
      if (!core.approvals.cardVisible() && !core.keys.isGlobalKey(keyId)) {
        return undefined;
      }
      core.approvalSurface.noteDroppedKey();
      return consumed();
    },
  },
  {
    name: 'approval',
    run: (core, { data, keyId }) =>
      core.approvals.cardVisible()
        ? core.approvals.handleKey(data, keyId)
        : undefined,
  },
  // The session tree owns every key while it shows in the editor's place:
  // its own actions, and typing for its search.
  {
    name: 'session-tree',
    run: (core, { data, keyId }) => {
      if (core.sessionTree.view === undefined) return undefined;
      core.sessionTree.handleKey(data, keyId);
      return consumed();
    },
  },
  // The palette is modal like the picker: Esc/Ctrl-C close
  // it, every other key is its own (a stray global key never acts
  // behind it). A terminal resized below its minimum closes it.
  {
    name: 'palette',
    run: (core, { data, action }) => {
      if (core.palette.current !== undefined && !core.overlays.fits()) {
        core.palette.close(true);
      }
      const open = core.palette.current;
      if (open === undefined) return undefined;
      if (isCancelKey(action)) core.palette.close(true);
      else open.view.handleInput(data);
      core.requestRender();
      return consumed();
    },
  },
  // The block viewer owns the keys while it shows.
  {
    name: 'block-viewer',
    run: (core, { data, action }) => {
      const viewer = core.blocks.viewer;
      if (viewer === undefined) return undefined;
      if (action === 'app.interrupt') core.blocks.closeViewer();
      else viewer.view.handleInput(data);
      core.requestRender();
      return consumed();
    },
  },
  // Block mode. Any key it does not take returns to typing
  // and is handled as usual (a printable key lands in the editor).
  {
    name: 'block-mode',
    run: (core, { data, keyId, action }) =>
      core.blocks.selected === undefined
        ? undefined
        : core.blocks.handleKey(data, keyId, action),
  },
  // The open panel's navigation. alt+up / alt+down cycle the
  // diff panel's files (and page the journal panel); neither key is
  // claimed by pi-tui's editor or alt-screen bindings, so the draft keeps
  // its own keys. A closed panel does not claim them at all.
  {
    name: 'panel',
    run: (core, { action }) => {
      if (!core.panel.isOpen()) return undefined;
      if (action !== 'panel.next' && action !== 'panel.previous') {
        return undefined;
      }
      core.panel.step(action === 'panel.next' ? 1 : -1);
      return consumed();
    },
  },
  // A shown confirmation owns every key. Only its explicit
  // accept key confirms; Esc/Ctrl-C cancel; anything else — a bare
  // printable letter typed ahead, a global toggle — is swallowed.
  {
    name: 'confirm',
    run: (core, { keyId, action }) => {
      const open = core.overlays.confirm;
      if (open === undefined) return undefined;
      if (keyId === open.options.confirmKey) {
        core.overlays.closeConfirm('confirm');
      } else if (isCancelKey(action)) {
        core.overlays.closeConfirm('cancel');
      }
      return consumed();
    },
  },
  // The picker is modal while it shows — arrows move, typing
  // filters, Enter selects, Esc/Ctrl-C cancel (Pi's own list bindings).
  // Global keys other than the cancel pair stay swallowed so a stray
  // Ctrl-T cannot toggle a tree behind the overlay. A terminal resized
  // below the overlay's minimum width closes it instead: the modal must
  // never outlive what the operator can see.
  {
    name: 'picker',
    run: (core, { data, action }) => {
      if (core.overlays.picker !== undefined && !core.overlays.fits()) {
        core.overlays.closePicker(true);
      }
      const open = core.overlays.picker;
      if (open === undefined) return undefined;
      if (isCancelKey(action)) {
        core.overlays.closePicker(true);
        return consumed();
      }
      open.view.handleInput(data);
      core.requestRender();
      return consumed();
    },
  },
  {
    name: 'global',
    run: (core, input) =>
      input.action === undefined
        ? undefined
        : GLOBAL_ACTIONS[input.action]?.(core, input),
  },
  {
    name: 'editor',
    run: (core, { data }) => {
      core.editor.handleInput(data);
      return consumed();
    },
  },
];

type GlobalAction = (
  core: AppCore,
  input: KeyInput,
) => TuiInputResult | undefined;

// The loop's global keys, looked up in the keybinding registry, so a
// rebound key acts and the old key falls through to the editor.
const GLOBAL_ACTIONS: Partial<Record<KeyAction, GlobalAction>> = {
  // Esc never quits. It closes the editor's dropdown (the
  // overlays above close themselves), then an open panel, interrupts a
  // running turn — the root makes the same cancel as a first Ctrl-C — and
  // on an idle, empty editor walks the blocks.
  'app.cancel': (core, { data }) => {
    core.approvals.denyPending();
    if (core.editor.isShowingAutocomplete()) {
      core.editor.handleInput(data);
      return consumed();
    }
    // An open panel is the top layer: Esc closes it before it interrupts.
    if (core.panel.isOpen()) {
      core.panel.set('closed');
      return consumed();
    }
    if (core.turn.busy) {
      return { quit: false, consumed: true, cancel: true, interrupt: true };
    }
    if (core.editor.getText() === '') core.blocks.enter();
    return consumed();
  },
  // Ctrl-C interrupts a running turn (a second press while
  // it drains quits — the root's rule); idle, it clears a draft, then
  // arms: a second press within QUIT_ARM_MS quits.
  'app.interrupt': (core) => {
    core.approvals.denyPending();
    if (core.turn.busy) return { quit: true, consumed: true, cancel: true };
    const key = keyCap(core.keys.label('app.interrupt'));
    if (core.editor.getText() !== '') {
      core.editor.setText('');
      core.quit.disarm();
      core.noticeRow.setFooter(`${key}: draft cleared`);
      return consumed();
    }
    if (core.quit.armed()) {
      core.quit.disarm();
      return { quit: true, consumed: true, cancel: true };
    }
    core.quit.arm(key);
    return consumed();
  },
  // An operator-bound quit key (app.exit has no default): a
  // composed draft is cleared first, an empty editor quits.
  'app.exit': (core) => {
    core.approvals.denyPending();
    if (core.editor.getText() !== '') {
      core.editor.setText('');
      const key = keyCap(core.keys.label('app.exit'));
      core.noticeRow.setFooter(
        `${key}: draft cleared — press ${key} again to quit`,
      );
      return consumed();
    }
    return { quit: true, consumed: true, cancel: false };
  },
  // Ctrl-D quits only on an empty draft — the shell convention. While
  // typing it stays Pi's delete-forward, so the key is never a silent
  // no-op in either state.
  'app.eof': (core, { data }) => {
    if (core.editor.getText() !== '') {
      core.editor.handleInput(data);
      return consumed();
    }
    return { quit: true, consumed: true, cancel: false };
  },
  'view.tree': (core) => {
    core.tree.handleInput('t');
    return consumed();
  },
  // Ctrl-O / Ctrl-R toggle the inspectable pair. Both are
  // free of pi-tui's own bindings (probed: editor bindings claim
  // a/b/c/d/e/f/g/j/k/u/w/y, the alt-screen claims the arrows, home/end,
  // page keys and ctrl+shift+*), and both are classified through the same
  // seam as every other global key.
  'panel.diff': (core) => {
    core.panel.toggle('diff');
    return consumed();
  },
  'panel.journal': (core) => {
    core.panel.toggle('journal');
    return consumed();
  },
  'transcript.expand': (core) => {
    core.transcript.toggleExpanded();
    return consumed();
  },
  // Alt+Enter is the steer key. The draft leaves the editor
  // here (like Enter clears it) and the loop decides: a running turn is
  // steered through the harness' own steer queue, an idle session gets
  // the text as a normal submit. An empty draft is a no-op, never a
  // blank steer.
  'prompt.steer': (core) => {
    const text = core.editor.getText().trim();
    if (text === '') return consumed();
    core.editor.setText('');
    return { quit: false, consumed: true, cancel: false, steer: text };
  },
  // Ctrl-P opens the command palette (the registry's rows);
  // the loop owns the list and the dispatch.
  'app.palette': () => ({
    quit: false,
    consumed: true,
    cancel: false,
    palette: true,
  }),
  // Alt+A asks the loop to toggle full access (the loop
  // confirms before enabling and writes the posture).
  'approvals.fullAccess': () => ({
    quit: false,
    consumed: true,
    cancel: false,
    fullAccess: true,
  }),
  // Alt+M opens the model picker; Alt+T cycles the thinking
  // level. Both are classified here and acted on by the loop.
  'model.pick': () => ({
    quit: false,
    consumed: true,
    cancel: false,
    pickModel: true,
  }),
  'model.thinking': () => ({
    quit: false,
    consumed: true,
    cancel: false,
    cycleThinking: true,
  }),
  // `?` on an idle, empty editor lists every key; anywhere
  // else it is the character.
  'help.keys': (core) =>
    !core.turn.busy && core.editor.getText() === '' && core.overlays.openKeys()
      ? consumed()
      : undefined,
};

export function routeInput(core: AppCore, data: string): TuiInputResult {
  const keyId = keyIdOf(data);
  const input: KeyInput = {
    data,
    keyId,
    action: core.keys.actionFor('global', keyId),
  };
  for (const route of INPUT_ROUTES) {
    const result = route.run(core, input);
    if (result !== undefined) return result;
  }
  return consumed();
}

function keyIdOf(data: string): string | undefined {
  try {
    return parseKey(data);
  } catch {
    // Unparseable input is not one of the global keys; it belongs to the
    // editor (parseKey throws on sequences it does not recognise).
    return undefined;
  }
}

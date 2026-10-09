// The theme and keybinding files, resolved before the screen opens.
import type { FileBridge } from '@kubic/exec/file-bridge';
import type { KeyRegistry } from '@kubic/tui/keybindings';
import {
  createKeyRegistry,
  KeybindingsError,
  parseKeybindingsJson,
} from '@kubic/tui/keybindings';
import type { ColorLevel, TuiTheme } from '@kubic/tui/theme';
import {
  builtinThemePalette,
  createThemeFromPalette,
  isThemeBuiltin,
  parseThemeJson,
  ThemeError,
} from '@kubic/tui/theme';

// The `[ui] theme` reference → the active theme. A
// built-in name (`default`, `dark`, `light`, `terminal`) needs
// no file; anything else is a JSON theme path, read through the exec bridge
// and validated against the schema (v2 token roles, or the v1 seven keys).
// Every failure is a `ThemeError` naming the reference, so the boot can
// report it before the screen opens.
export function resolveTuiTheme(
  ref: string | undefined,
  level: ColorLevel,
  files: FileBridge,
): TuiTheme {
  if (ref === undefined || ref === '' || isThemeBuiltin(ref)) {
    const name = ref === undefined || ref === '' ? 'dark' : ref;
    return createThemeFromPalette(builtinThemePalette(name), level, name);
  }
  let text: string;
  try {
    // The regular-file check comes FIRST: `readTextFile`
    // is an unbounded `readFileSync`, so a config `[ui] theme` naming a FIFO
    // would block the event loop before the alt-screen ever opens (no Ctrl-C
    // handler exists yet), `/dev/zero` would read forever, and a huge file
    // would be read whole. Same rule `readImageFile` follows.
    const info = files.fileInfo(ref);
    if (info.isFile === false) {
      throw new ThemeError(`theme '${ref}': not a regular file`);
    }
    if (info.size > THEME_MAX_BYTES) {
      throw new ThemeError(
        `theme '${ref}': too large (> ${Math.round(THEME_MAX_BYTES / 1024)} KB)`,
      );
    }
    text = files.readTextFile(ref);
  } catch (error) {
    if (error instanceof ThemeError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ThemeError(`theme '${ref}': cannot read (${detail})`);
  }
  return createThemeFromPalette(parseThemeJson(text, ref), level, ref);
}

// The keybindings file → the registry the app
// dispatches through. A missing file is the shipped bindings; a present one
// is read through the exec bridge with the same regular-file and size guard
// as a theme, and an invalid one is a `KeybindingsError` naming the file and
// the entry, so the boot refuses it (exit 2) before the screen opens.
export function resolveTuiKeybindings(
  path: string,
  files: FileBridge,
): KeyRegistry {
  if (!files.exists(path)) return createKeyRegistry();
  let text: string;
  try {
    const info = files.fileInfo(path);
    if (info.isFile === false) {
      throw new KeybindingsError(`keybindings '${path}': not a regular file`);
    }
    if (info.size > THEME_MAX_BYTES) {
      throw new KeybindingsError(
        `keybindings '${path}': too large (> ${Math.round(THEME_MAX_BYTES / 1024)} KB)`,
      );
    }
    text = files.readTextFile(path);
  } catch (error) {
    if (error instanceof KeybindingsError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new KeybindingsError(
      `keybindings '${path}': cannot read (${detail})`,
    );
  }
  return createKeyRegistry(parseKeybindingsJson(text, path));
}

// The largest theme file Kubic reads: a theme is a few
// hundred bytes of JSON, so this is generous by orders of magnitude while
// still refusing a path that would be read whole for no reason.
export const THEME_MAX_BYTES = 64 * 1024;

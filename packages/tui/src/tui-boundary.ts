// TUI presentation seam (issue #22).
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui presentation components (VStack layout,
//     Text/ScrollView/Editor slots, TuiAltScreen, Terminal contract, the
//     editor's autocomplete contract of issue #305)
//   used by: packages/tui/src/* (all layout and views)
//   why Pi has no alternative: the terminal renderer, layout engine, and
//     input handling ARE Pi's presentation layer (§16); Kubic owns only
//     the arrangement and the data fed into slots
//   review: issue #22

export type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  Component,
  EditorTheme,
  Focusable,
  ImageProtocol,
  ImageTheme,
  MarkdownTheme,
  MouseRegionHandler,
  SelectItem,
  SelectListTheme,
  StackEntryOptions,
  Terminal,
  TerminalCapabilities,
  TUI,
} from '@earendil-works/pi-tui';
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui values (Editor, Markdown, ScrollView, Text,
//     VStack, TuiAltScreen, ProcessTerminal, SelectList, key helpers, width
//     helpers)
//   used by: packages/tui/src/* (the rendered views, the `/model` picker
//     overlay of issue #328, and the headless snapshot tests; issue #403
//     re-verifies them on pi-tui 1.0.2)
//   why Pi has no alternative: these are the upstream implementations of the
//     layout and render primitives above; Kubic re-implementing them would
//     fork terminal handling, wrapping and key parsing (§16)
//   review: issue #197 (folded into #391)
// --- #338 additions ---
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui terminal-image probing and the Image
//     component (getCapabilities/resetCapabilitiesCache/setCapabilities and
//     the Component it renders)
//   used by: packages/tui/src/attachments.ts (prompt image attachments),
//     plus the headless tests that pin both terminals (`setCapabilities`)
//   why Pi has no alternative: the capability probe (kitty/iTerm2 protocol,
//     truecolor, hyperlinks) and the protocol encoders ARE Pi's terminal
//     layer; Kubic owns only the placeholder fallback and the decision to
//     attach (§16.5 Image, §16.8 Images)
//   review: issue #338
// --- #154 additions ---
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui Input (the single-line text field)
//   used by: packages/tui/src/question-view.ts (a worker's free-text
//     question, §14.2, answered in the TUI's orchestrator mode)
//   why Pi has no alternative: Input is Pi's own line editor (cursor, kill
//     ring, bracketed paste, undo); a Kubic copy would fork key handling
//   review: issue #154
// --- #453 additions ---
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui isKittyProtocolActive (whether the Kitty
//     keyboard protocol was negotiated with the terminal)
//   used by: packages/tui/src/tui-app.ts (the key-hint row names Shift+Enter
//     as the newline key only where the terminal can report it, else Ctrl-J)
//   why Pi has no alternative: Pi negotiates the protocol and owns the flag;
//     Kubic only reads it, never sets it
//   review: issue #453
export {
  CURSOR_MARKER,
  Editor,
  getCapabilities,
  Image,
  Input,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Markdown,
  MouseRegion,
  matchesKey,
  ProcessTerminal,
  parseKey,
  resetCapabilitiesCache,
  ScrollView,
  SelectList,
  setCapabilities,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

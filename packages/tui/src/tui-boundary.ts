// TUI presentation seam.
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui presentation components (VStack layout,
//     Text/ScrollView/Editor slots, TuiAltScreen, Terminal contract, the
//     editor's autocomplete contract)
//   used by: packages/tui/src/* (all layout and views)
//   why Pi has no alternative: the terminal renderer, layout engine, and
//     input handling ARE Pi's presentation layer; Kubic owns only
//     the arrangement and the data fed into slots

export type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  Component,
  EditorTheme,
  Focusable,
  MarkdownTheme,
  MouseRegionHandler,
  Terminal,
  TUI,
} from '@earendil-works/pi-tui';
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui values (Editor, Markdown, ScrollView, Text,
//     VStack, TuiAltScreen, ProcessTerminal, key helpers, width helpers
//     including sliceByColumn, which pans the session tree sideways)
//   used by: packages/tui/src/* (the rendered views and the headless
//     snapshot tests; the pickers are Kubic's own list)
//   why Pi has no alternative: these are the upstream implementations of the
//     layout and render primitives above; Kubic re-implementing them would
//     fork terminal handling, wrapping and key parsing
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui terminal-image probing and the Image
//     component (getCapabilities/resetCapabilitiesCache/setCapabilities and
//     the Component it renders)
//   used by: packages/tui/src/attachments.ts (prompt image attachments),
//     plus the headless tests that pin both terminals (`setCapabilities`)
//   why Pi has no alternative: the capability probe (kitty/iTerm2 protocol,
//     truecolor, hyperlinks) and the protocol encoders ARE Pi's terminal
//     layer; Kubic owns only the placeholder fallback and the decision to
//     attach
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui Input (the single-line text field)
//   used by: packages/tui/src/palette-view.ts and picker-view.ts (the
//     palette and picker query fields)
//   why Pi has no alternative: Input is Pi's own line editor (cursor, kill
//     ring, bracketed paste, undo); a Kubic copy would fork key handling
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui isKittyProtocolActive (whether the Kitty
//     keyboard protocol was negotiated with the terminal)
//   used by: packages/tui/src/tui-app.ts (the key-hint row names Shift+Enter
//     as the newline key only where the terminal can report it, else Ctrl-J)
//   why Pi has no alternative: Pi negotiates the protocol and owns the flag;
//     Kubic only reads it, never sets it
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui fuzzyMatch (the subsequence scorer behind
//     Pi's own fuzzyFilter: consecutive and word-boundary letters score
//     better, lower is better)
//   used by: packages/tui/src/ui/palette.ts (the ^P palette ranks every
//     group's rows with it, the name above the summary)
//   why Pi has no alternative: it is Pi's ranking; ranking the palette with
//     a Kubic copy would order rows differently from Pi's own pickers
export {
  CURSOR_MARKER,
  Editor,
  fuzzyMatch,
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
  /** @internal */ resetCapabilitiesCache,
  ScrollView,
  /** @internal */ setCapabilities,
  sliceByColumn,
  /** @internal */ Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

# Space Namer Lite

Space Namer Lite is a macOS-only Stream Deck plugin for temporary session names and keyboard-driven switching for macOS Spaces.

## What it does

- Reads normal macOS Desktop spaces from `~/Library/Preferences/com.apple.spaces.plist`.
- Shows temporary per-boot names on Stream Deck keys.
- Prompts for names when new desktops are detected.
- Switches spaces using macOS Control-Left and Control-Right keyboard shortcuts.
- Runs without Homebrew, yabai, Hammerspoon, DesktopRenamer, SIP changes, or npm dependencies.

## Install

Open `dist/cheersyan.gpt.spacenamer.streamDeckPlugin` to install the packaged plugin in Stream Deck.

The plugin requires:

- macOS 13 or newer
- Stream Deck 7.1 or newer
- Node.js 20 from the Stream Deck runtime

## Permissions

macOS may require Accessibility permission for Stream Deck so the plugin can trigger the built-in Control-Arrow shortcuts through System Events.

## Development

The plugin source lives in `cheersyan.gpt.spacenamer.sdPlugin`.

To rebuild the installable archive:

```sh
tools/package.sh
```

## License

MIT. See `LICENSE`.

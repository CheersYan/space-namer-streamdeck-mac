# Space Namer Lite

Space Namer Lite is a macOS-only Stream Deck plugin for temporary session names and keyboard-driven switching for macOS Spaces.

## What it does

- Reads normal macOS Desktop spaces from `~/Library/Preferences/com.apple.spaces.plist`.
- Uses the bundled `spacectl` native helper to read the live active macOS Space ID from SkyLight.
- Shows temporary per-boot names on Stream Deck keys.
- Adds a Current Desktop action that displays the plugin's current desktop.
- Prompts for names when new desktops are detected.
- Switches spaces using macOS Control-Left and Control-Right keyboard shortcuts, then verifies the active Space with SkyLight when available.
- Runs without Homebrew, yabai, Hammerspoon, DesktopRenamer, SIP changes, or npm dependencies.

## Install

Open `dist/cheersyan.gpt.spacenamer.streamDeckPlugin` to install the packaged plugin in Stream Deck.

The plugin requires:

- macOS 13 or newer
- Stream Deck 7.1 or newer
- Node.js 20 from the Stream Deck runtime

## Actions

- Desktop 1-16: tap to switch to that desktop slot. Hold to rename the desktop for the current macOS boot session.
- Current Desktop: shows the currently active desktop slot without switching Spaces.
- Name Desktops: prompts for temporary names for every detected desktop.
- Refresh Spaces: rereads the current Spaces topology.

## Permissions

macOS may require Accessibility permission for Stream Deck so the plugin can trigger the built-in Control-Arrow shortcuts through System Events.

The native `spacectl` helper reads the active Space ID from macOS SkyLight. It does not require extra user configuration. If SkyLight is unavailable or returns an invalid ID, the plugin falls back to the persisted Spaces plist.

## Development

The plugin source lives in `cheersyan.gpt.spacenamer.sdPlugin`.

The native helper source lives in `src/spacectl.m`. The packaged helper binary is written to `cheersyan.gpt.spacenamer.sdPlugin/bin/spacectl`, next to `plugin.js`, because the plugin resolves it with `path.join(__dirname, "spacectl")`.

To rebuild the installable archive:

```sh
tools/package.sh
```

Packaging requires Apple's command line tools because `tools/package.sh` compiles the helper with `xcrun clang` and links Foundation plus the private SkyLight framework.

The package script writes:

- `cheersyan.gpt.spacenamer.sdPlugin/bin/spacectl`
- `dist/cheersyan.gpt.spacenamer.streamDeckPlugin`

## Runtime Notes

The plugin uses two sources of Spaces state:

- The plist is used for slow-changing topology: desktop order, UUIDs, managed IDs, and normal desktop filtering.
- SkyLight is used for live current Space detection: the helper returns the active numeric managed Space ID, and the plugin maps it back to the plist Space UUID.

If the helper fails, is missing, or returns `0`, switching still falls back to the plist/order-based behavior.

For more detail, see `docs/native-helper.md`.

## Troubleshooting

- If switching does nothing, confirm Stream Deck has macOS Accessibility permission and that the Control-Left/Control-Right Mission Control shortcuts work outside the plugin.
- If the Current Desktop key shows `Current (?)`, press Refresh Spaces and make sure the active Space is a normal Desktop space rather than Mission Control, a full-screen app, or another non-desktop Space.
- If packaging fails with `xcrun: error`, install Apple's command line tools with `xcode-select --install`.

## License

MIT. See `LICENSE`.

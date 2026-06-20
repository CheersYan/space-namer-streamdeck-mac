# Native Space Helper

Space Namer Lite keeps the existing plist parser for topology and uses a tiny native helper for live current-Space detection.

## Files

- `src/spacectl.m`: Objective-C source for the helper.
- `cheersyan.gpt.spacenamer.sdPlugin/bin/spacectl`: compiled helper bundled next to `plugin.js`.
- `tools/package.sh`: compiles the helper and creates `dist/cheersyan.gpt.spacenamer.streamDeckPlugin`.

## Commands

`spacectl` supports two commands:

```sh
spacectl active
spacectl dump
```

`active` prints the active managed Space ID as a decimal integer. `dump` prints JSON containing the active managed Space ID and the SkyLight managed display spaces payload.

The helper treats `0` as invalid and exits nonzero. The Node plugin also rejects `0`, because a zero active Space ID means SkyLight did not provide a usable live Space.

## Build

The package script compiles the helper with:

```sh
xcrun clang -ObjC -fobjc-arc \
  -framework Foundation \
  -F/System/Library/PrivateFrameworks \
  -framework SkyLight \
  src/spacectl.m \
  -o cheersyan.gpt.spacenamer.sdPlugin/bin/spacectl
```

Then it marks the binary executable and zips the full `.sdPlugin` directory.

## Runtime Flow

The plugin still reads `~/Library/Preferences/com.apple.spaces.plist` with `/usr/bin/plutil`. That plist snapshot provides:

- Space UUIDs, used as the plugin's canonical IDs.
- Managed Space IDs, used to map SkyLight's numeric active ID back to a UUID.
- Desktop ordering.
- Normal-desktop filtering.

For live current-space state, Node executes:

```js
execFileAsync(path.join(__dirname, "spacectl"), ["active"])
```

The returned managed ID is matched against `topology.allSpaces[].managedId`. When a match is found, `topology.currentSpaceId` is replaced with that Space UUID for rendering and switching.

## Switching

Switching still sends macOS Control-Left and Control-Right shortcuts through System Events. After each arrow key press, the plugin polls `spacectl active` and stops as soon as the active managed ID matches the target desktop's managed ID.

If SkyLight is unavailable, the helper is missing, or the active ID cannot be mapped to the plist topology, the plugin falls back to the plist/order-based switch wait path. This preserves the old behavior while using SkyLight as the faster live signal when available.

## Limitations

- The helper uses macOS private SkyLight APIs, so behavior can change across macOS releases.
- Stream Deck still needs Accessibility permission for keyboard-driven switching.
- The plugin's topology model currently selects one primary monitor, so multi-monitor Spaces behavior remains constrained by the existing plist parser.

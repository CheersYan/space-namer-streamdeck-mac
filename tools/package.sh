#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="cheersyan.gpt.spacenamer.sdPlugin"
OUT_DIR="$ROOT_DIR/dist"
OUT_FILE="$OUT_DIR/cheersyan.gpt.spacenamer.streamDeckPlugin"

mkdir -p "$OUT_DIR"
tmp_dir="$(mktemp -d "$OUT_DIR/.package.XXXXXX")"
tmp_file="$tmp_dir/cheersyan.gpt.spacenamer.streamDeckPlugin"

(
  cd "$ROOT_DIR"
  zip -r -X "$tmp_file" "$PLUGIN_DIR" \
    -x "$PLUGIN_DIR/logs/*" \
    -x "*.DS_Store"
)

mv "$tmp_file" "$OUT_FILE"
rmdir "$tmp_dir"
echo "Wrote $OUT_FILE"

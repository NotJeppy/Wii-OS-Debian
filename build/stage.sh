#!/bin/bash
# Copies the files that make up an installed Wii-OS into DEST/wii-os, plus
# the version and update settings that installed boxes use to find updates.
# Used for both the ISO and the update bundle attached to each release.
#   WII_OS_VERSION=v2026.10.22.7 WII_OS_REPO=owner/name build/stage.sh DEST
# Without WII_OS_REPO the result never checks for updates.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$1/wii-os"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$ROOT/bin" "$ROOT/system" "$ROOT/wiid" "$ROOT/ui" "$ROOT/LICENSE" "$ROOT/README.md" "$DEST/"
sed -i 's/\r$//' "$DEST/bin/"* "$DEST/system/"*.sh "$DEST/system/"*.py "$DEST/wiid/"*.py
chmod +x "$DEST/bin/"* "$DEST/system/"*.sh

echo "${WII_OS_VERSION:-dev}" > "$DEST/VERSION"
printf '{"repo": "%s"}\n' "${WII_OS_REPO:-}" > "$DEST/update.json"

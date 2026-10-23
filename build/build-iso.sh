#!/bin/bash
# Builds the Wii-OS installer ISO from Debian's official netinst ISO: adds the
# Wii-OS files and an answer file, and swaps in our boot menus. The result
# boots on BIOS and UEFI like the original and installs over the network.
#   build/build-iso.sh [out.iso]
#   WII_OS_VERSION=... WII_OS_REPO=owner/name build/build-iso.sh   release build
#   WII_OS_TEST=1 build/build-iso.sh test.iso   fully unattended, for VM tests
# Needs: xorriso, wget, sha256sum.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(realpath -m "${1:-$ROOT/out/wii-os.iso}")"
CACHE="${CACHE_DIR:-$ROOT/out/cache}"
MIRROR="https://cdimage.debian.org/debian-cd/current/amd64/iso-cd"
mkdir -p "$CACHE" "$(dirname "$OUT")"

echo "==> Finding the current Debian netinst ISO"
wget -q -O "$CACHE/SHA256SUMS" "$MIRROR/SHA256SUMS"
ISO_NAME="$(grep -oE 'debian-[0-9.]+-amd64-netinst\.iso' "$CACHE/SHA256SUMS" | head -1)"
verify() { (cd "$CACHE" && grep " $ISO_NAME\$" SHA256SUMS | sha256sum -c --status); }
if ! verify 2>/dev/null; then
  echo "==> Downloading $ISO_NAME"
  wget -q -O "$CACHE/$ISO_NAME" "$MIRROR/$ISO_NAME"
  verify || { echo "Checksum mismatch for $ISO_NAME" >&2; exit 1; }
fi
echo "    using $ISO_NAME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

bash "$ROOT/build/stage.sh" "$STAGE"  # honours WII_OS_VERSION / WII_OS_REPO

cp "$ROOT/build/preseed.cfg" "$STAGE/preseed.cfg"
EXTRA=""
if [ -n "${WII_OS_TEST:-}" ]; then
  echo "==> Test build: unattended install that wipes /dev/vda"
  cat "$ROOT/build/test-answers.cfg" >> "$STAGE/preseed.cfg"
  EXTRA="auto=true priority=critical"
fi
sed "s|@EXTRA@|$EXTRA|" "$ROOT/build/grub.cfg" > "$STAGE/grub.cfg"
sed "s|@EXTRA@|$EXTRA|" "$ROOT/build/isolinux.cfg" > "$STAGE/isolinux.cfg"

echo "==> Writing $OUT"
rm -f "$OUT"
xorriso -report_about WARNING \
  -indev "$CACHE/$ISO_NAME" -outdev "$OUT" \
  -map "$STAGE/wii-os" /wii-os \
  -map "$STAGE/preseed.cfg" /preseed/wii-os.cfg \
  -map "$STAGE/grub.cfg" /boot/grub/grub.cfg \
  -map "$STAGE/isolinux.cfg" /isolinux/isolinux.cfg \
  -boot_image any replay

(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "==> Done: $OUT ($(du -h "$OUT" | cut -f1))"

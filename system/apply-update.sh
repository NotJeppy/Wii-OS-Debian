#!/bin/bash
# Installs a Wii-OS release over the current one. wiid runs this through sudo
# when the user accepts an update (see the sudoers rule in install.sh).
#   sudo /opt/wii-os/system/apply-update.sh v2026.10.22.7
# Downloads that release's update bundle from GitHub, checks it, swaps it in
# for the running copy, and re-runs install.sh. On failure the old copy is
# put back.
set -euo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^v[0-9][0-9.]*$ ]] || { echo "bad version: $TAG" >&2; exit 2; }

OS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
config() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], sys.argv[3]))' "$OS_DIR/update.json" "$@"; }
REPO="$(config repo "")"
DOWNLOADS="$(config downloads https://github.com)"  # overridable for testing
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "bad repo: $REPO" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
URL="$DOWNLOADS/$REPO/releases/download/$TAG/wii-os-$TAG.tar.gz"

echo "==> Downloading $TAG"
wget -q -O "$WORK/bundle.tar.gz" "$URL"
wget -q -O "$WORK/bundle.sha256" "$URL.sha256"
EXPECTED="$(cut -d' ' -f1 "$WORK/bundle.sha256")"
echo "$EXPECTED  $WORK/bundle.tar.gz" | sha256sum -c --status || { echo "checksum mismatch" >&2; exit 1; }

mkdir "$WORK/new"
tar -xzf "$WORK/bundle.tar.gz" -C "$WORK/new"
[ -f "$WORK/new/wii-os/system/install.sh" ] || { echo "bundle is missing files" >&2; exit 1; }

echo "==> Swapping in the new version"
NEW="$OS_DIR.new"
OLD="$OS_DIR.old"
rm -rf "$NEW" "$OLD"
cp -a "$WORK/new/wii-os" "$NEW"
mv "$OS_DIR" "$OLD"
mv "$NEW" "$OS_DIR"

echo "==> Running install.sh"
if ! bash "$OS_DIR/system/install.sh"; then
  echo "install.sh failed; restoring the previous version" >&2
  rm -rf "$OS_DIR"
  mv "$OLD" "$OS_DIR"
  exit 1
fi
rm -rf "$OLD"
echo "Updated to $TAG."

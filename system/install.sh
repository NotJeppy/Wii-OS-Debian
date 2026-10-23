#!/bin/bash
# Turns a minimal Debian 13 install into a wii-os box. Safe to re-run.
#   sudo ./system/install.sh            set everything up
#   sudo ./system/install.sh --restart  ...and restart the TV session afterwards
# The ISO's installer also runs this at the end of an install (see build/),
# inside the new system's chroot, with no sudo and nothing running yet.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo." >&2
  exit 1
fi

# The TV user: whoever ran sudo, else the first regular account.
USER_NAME="${SUDO_USER:-$(getent passwd 1000 | cut -d: -f1)}"
if [ -z "$USER_NAME" ]; then
  echo "No user account found." >&2
  exit 1
fi
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
OS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Installing packages"
# The installer leaves its USB stick listed as a package source; apt-get
# update fails on it once the stick is gone (and inside the installer).
sed -i 's/^deb cdrom:/# deb cdrom:/' /etc/apt/sources.list 2>/dev/null || true
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  cage chromium \
  python3 python3-evdev \
  dbus-user-session libpam-systemd \
  pipewire pipewire-pulse pipewire-alsa wireplumber rtkit \
  mesa-va-drivers mesa-vulkan-drivers libgl1-mesa-dri \
  fonts-quicksand fonts-noto-core fonts-noto-color-emoji \
  grim flatpak wget ca-certificates

echo "==> Google Chrome (has the Widevine DRM that Netflix, Hulu and Disney+ need)"
if ! dpkg -s google-chrome-stable >/dev/null 2>&1; then
  # Google's own package; it also adds Google's apt repository for updates.
  CHROME_DEB="$(mktemp -d)/google-chrome-stable_current_amd64.deb"
  wget -q -O "$CHROME_DEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$CHROME_DEB"
  rm -f "$CHROME_DEB"
fi

# Native channel apps such as Plex HTPC come from Flathub when the user gets
# them in the Channel Shop (see wiid/home.py and the flatpak_overrides in
# wiid/channels.json).

echo "==> Input access (controller + virtual keyboard)"
usermod -aG input,video,render,audio "$USER_NAME"
echo uinput > /etc/modules-load.d/uinput.conf
cat > /etc/udev/rules.d/60-wii-os-uinput.rules <<'EOF'
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
EOF
# These only matter on a running system; in the installer's chroot they fail.
modprobe uinput 2>/dev/null || true
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger --subsystem-match=misc --sysname-match=uinput 2>/dev/null || true

echo "==> Auto-login on the TV (tty1)"
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $USER_NAME --noclear --skip-login --nonewline --noissue %I \$TERM
EOF

echo "==> Power menu and update permissions"
cat > /etc/sudoers.d/wii-os-power <<EOF
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff, /usr/bin/systemctl reboot
$USER_NAME ALL=(root) NOPASSWD: $OS_DIR/system/apply-update.sh
EOF
chmod 440 /etc/sudoers.d/wii-os-power
visudo -cf /etc/sudoers.d/wii-os-power

echo "==> Start the TV session on login"
PROFILE="$HOME_DIR/.bash_profile"
MARK="# wii-os session"
touch "$PROFILE"
if ! grep -qF "$MARK" "$PROFILE"; then
  cat >> "$PROFILE" <<EOF

$MARK
if [ "\$(tty)" = /dev/tty1 ] && [ -z "\$WAYLAND_DISPLAY" ]; then
  exec "$OS_DIR/bin/start-session"
fi
EOF
fi
chown "$USER_NAME:$USER_NAME" "$PROFILE"
chmod +x "$OS_DIR"/bin/*

echo "==> Invisible mouse cursor"
# Controller receivers often also show up as a mouse, which puts a cursor in
# the middle of the screen. start-session selects this theme; the "default"
# override covers anything that ignores XCURSOR_THEME (like cage itself).
python3 "$OS_DIR/system/make-blank-cursors.py" /usr/share/icons/wii-os-blank
mkdir -p "$HOME_DIR/.local/share/icons/default"
printf '[Icon Theme]\nInherits=wii-os-blank\n' > "$HOME_DIR/.local/share/icons/default/index.theme"
chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/.local"

systemctl daemon-reload 2>/dev/null || true

if [ "${1:-}" = "--restart" ]; then
  echo "==> Restarting the TV session"
  systemctl restart getty@tty1
fi

echo "Done."

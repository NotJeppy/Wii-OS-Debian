#!/usr/bin/env python3
"""Hands the installer's network setup over to NetworkManager. Run by install.sh.

Debian's installer writes the connection it used (often Wi-Fi with its
password) to /etc/network/interfaces. NetworkManager won't touch interfaces
listed there, so the Settings channel couldn't show or change them. This
saves each Wi-Fi network as a NetworkManager connection and leaves only the
loopback in that file.

Only simple setups (DHCP, optionally with wpa-ssid/wpa-psk) are moved; anything
else is left as it is. On a running system the switch happens in the
background, so an SSH session over that connection doesn't cut it off half
way, and the old setup comes back if NetworkManager isn't online within a
minute.
"""
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

INTERFACES = Path("/etc/network/interfaces")
BACKUP = Path("/etc/network/interfaces.wii-os-backup")
STAGED = Path("/etc/network/interfaces.wii-os-new")
CONNECTIONS = Path("/etc/NetworkManager/system-connections")
SIMPLE_OPTIONS = {"wpa-ssid", "wpa-psk"}


def parse(text):
    """The non-loopback interfaces: {name: {"methods": set, "options": {k: v}}}."""
    ifaces, current = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        word, _, rest = line.partition(" ")
        if word == "iface":
            name, family, method = (rest.split() + ["", ""])[:3]
            current = None if name == "lo" else ifaces.setdefault(name, {"methods": set(), "options": {}})
            if current is not None:
                current["methods"].add(f"{family} {method}")
        elif word in ("auto", "allow-hotplug", "source", "source-directory", "mapping"):
            current = None
            if word == "mapping":
                return None  # too clever to move safely
        elif current is not None:
            current["options"][word] = rest.strip().strip('"')
    return ifaces


def simple(iface):
    return (iface["methods"] <= {"inet dhcp", "inet6 auto", "inet6 dhcp"}
            and set(iface["options"]) <= SIMPLE_OPTIONS)


def keyfile(ssid, psk):
    text = f"[connection]\nid={ssid}\ntype=wifi\n\n[wifi]\nmode=infrastructure\nssid={ssid}\n\n"
    if psk:
        text += f"[wifi-security]\nkey-mgmt=wpa-psk\npsk={psk}\n\n"
    return text + "[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n"


def in_chroot():
    # The installer runs install.sh in the new system's chroot: nothing to restart.
    return subprocess.run(["systemd-detect-virt", "--chroot"]).returncode == 0 or not Path("/run/systemd/system").is_dir()


def main():
    try:
        text = INTERFACES.read_text()
    except OSError:
        return
    ifaces = parse(text)
    if not ifaces:
        return  # nothing but the loopback (or a setup we don't touch)
    if BACKUP.exists():
        print("network: moving to NetworkManager didn't work before; leaving it to ifupdown")
        return
    if not all(simple(i) for i in ifaces.values()):
        print("network: /etc/network/interfaces isn't a simple DHCP setup; leaving it to ifupdown")
        return

    written = []
    CONNECTIONS.mkdir(parents=True, exist_ok=True)
    for name, iface in ifaces.items():
        ssid = iface["options"].get("wpa-ssid")
        if not ssid:
            continue  # wired: NetworkManager connects it by itself
        if re.search(r"[\n;\\]", ssid + iface["options"].get("wpa-psk", "")):
            print(f"network: can't move Wi-Fi network {ssid!r}; leaving it to ifupdown")
            return
        path = CONNECTIONS / f"{re.sub(r'[^A-Za-z0-9._-]', '_', ssid)}.nmconnection"
        path.write_text(keyfile(ssid, iface["options"].get("wpa-psk")))
        os.chmod(path, 0o600)
        written.append(path)
        print(f"network: saved Wi-Fi network {ssid} for NetworkManager")

    BACKUP.write_text(text)
    STAGED.write_text(
        "# Wii-OS: networks are managed by NetworkManager (Settings > Wi-Fi).\n"
        f"# What the installer wrote is in {BACKUP}.\n\n"
        "source /etc/network/interfaces.d/*\n\n"
        "auto lo\niface lo inet loopback\n"
    )
    names = " ".join(shlex.quote(n) for n in ifaces)
    if in_chroot():
        STAGED.replace(INTERFACES)
        return

    files = " ".join(shlex.quote(str(p)) for p in written)
    script = f"""
        ifdown --force {names} || true
        mv {STAGED} {INTERFACES}
        systemctl restart NetworkManager
        if nm-online -q -t 60; then
            echo "network: NetworkManager is online"
            exit 0
        fi
        echo "network: NetworkManager didn't get online; putting the old setup back"
        cp {BACKUP} {INTERFACES}
        rm -f {files}
        systemctl restart NetworkManager
        ifup {names}
        exit 1
    """
    subprocess.run(["systemd-run", "--unit", "wii-os-network-move", "--collect",
                    "/bin/sh", "-c", script], check=True)
    print("network: switching to NetworkManager in the background (journalctl -u wii-os-network-move)")


if __name__ == "__main__":
    sys.exit(main())

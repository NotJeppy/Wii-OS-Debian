"""Wi-Fi and Bluetooth, for the Settings channel.

Wi-Fi goes through NetworkManager (nmcli). Bluetooth goes through BlueZ: its
state is read over D-Bus (python3-dbus), and one long-running bluetoothctl does
the rest. That bluetoothctl is also the pairing agent, so it answers the
"is this OK?" questions some devices ask while pairing, and shows the code a
keyboard wants typed.

install.sh lets the TV user change NetworkManager settings without a password
(polkit) and hands the installer's Wi-Fi setup over to NetworkManager.
"""
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path


def run(cmd, timeout=20):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as err:
        return subprocess.CompletedProcess(cmd, 1, "", str(err))


def fields(line):
    """Splits a line of `nmcli -t` output, which escapes ':' and '\\' with '\\'."""
    out, cur, escaped = [], "", False
    for ch in line:
        if escaped:
            cur += ch
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == ":":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def nmcli(*args, timeout=20):
    return run(["nmcli", *args], timeout=timeout)


def rows(*args):
    res = nmcli("-t", *args)
    return [fields(line) for line in res.stdout.splitlines() if line] if res.returncode == 0 else []


class Wifi:
    def __init__(self, log):
        self.log = log
        self.lock = threading.Lock()  # one connection attempt at a time
        self.connecting = None  # the SSID being joined

    def device(self):
        """The Wi-Fi interface and its state, or None without Wi-Fi hardware."""
        # Ask the kernel first: instant, and no Wi-Fi means nothing to ask nmcli.
        if not shutil.which("nmcli") or not any(Path("/sys/class/net").glob("*/wireless")):
            return None
        for dev, kind, state, conn in rows("-f", "DEVICE,TYPE,STATE,CONNECTION", "device"):
            if kind == "wifi":
                return {"name": dev, "state": state, "connection": conn}
        return None

    def saved(self):
        """Saved Wi-Fi networks, as {ssid: connection name}."""
        out = {}
        for name, kind in rows("-f", "NAME,TYPE", "connection", "show"):
            if kind == "802-11-wireless":
                ssid = nmcli("-t", "-g", "802-11-wireless.ssid", "connection", "show", "id", name).stdout.strip()
                out[fields(ssid)[0] or name] = name
        return out

    def wired(self):
        return any(kind == "ethernet" and state == "connected"
                   for _, kind, state in rows("-f", "DEVICE,TYPE,STATE", "device"))

    def status(self):
        dev = self.device()
        if not dev:
            return {"available": False}
        on = nmcli("radio", "wifi").stdout.strip() == "enabled"
        saved = self.saved()
        networks = {}
        for in_use, ssid, signal, security in rows(
                "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "no"):
            if not ssid or ssid.startswith("DIRECT-"):
                # Hidden networks, and Wi-Fi Direct ones (a Roku's remote, a
                # printer), which never lead to the internet.
                continue
            net = {
                "ssid": ssid,
                "signal": int(signal or 0),
                "secure": bool(security.strip()) and security.strip() != "--",
                "enterprise": "802.1X" in security,
                "connected": in_use == "*",
                "saved": ssid in saved,
            }
            best = networks.get(ssid)  # one row per access point: keep the strongest
            if not best or net["connected"] or (not best["connected"] and net["signal"] > best["signal"]):
                networks[ssid] = net
        current = next((n["ssid"] for n in networks.values() if n["connected"]), None)
        listed = sorted(networks.values(), key=lambda n: (not n["connected"], not n["saved"], -n["signal"]))
        return {
            "available": True,
            "on": on,
            "current": current,
            "wired": self.wired(),
            "connecting": self.connecting,
            "networks": listed[:30],
        }

    def scan(self):
        # Returns at once; results show up in the list over the next seconds.
        nmcli("device", "wifi", "rescan")
        return True

    def set_on(self, on):
        return nmcli("radio", "wifi", "on" if on else "off").returncode == 0

    def connect(self, ssid, password=None):
        if not ssid or not self.lock.acquire(blocking=False):
            return {"ok": False, "error": "Already connecting to a network."}
        self.connecting = ssid
        try:
            saved = self.saved()
            if ssid in saved and not password:
                res = nmcli("--wait", "45", "connection", "up", "id", saved[ssid], timeout=60)
            else:
                if ssid in saved:  # a new password replaces the saved one
                    nmcli("connection", "delete", "id", saved[ssid])
                cmd = ["--wait", "45", "device", "wifi", "connect", ssid]
                if password:
                    cmd += ["password", password]
                res = nmcli(*cmd, timeout=60)
                if res.returncode != 0:
                    # Don't keep a network whose password didn't work.
                    nmcli("connection", "delete", "id", ssid)
            if res.returncode == 0:
                self.log(f"wifi: connected to {ssid}")
                return {"ok": True}
            message = (res.stderr or res.stdout).strip()
            self.log(f"wifi: couldn't connect to {ssid}: {message}")
            if re.search(r"secrets|password|802-11-wireless-security|psk", message, re.I):
                return {"ok": False, "error": "The password didn't work."}
            return {"ok": False, "error": "Couldn't connect to this network."}
        finally:
            self.connecting = None
            self.lock.release()

    def forget(self, ssid):
        name = self.saved().get(ssid)
        if not name:
            return False
        self.log(f"wifi: forgetting {ssid}")
        return nmcli("connection", "delete", "id", name).returncode == 0


ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x01|\x02|\r")
KINDS = {
    "input-gaming": "Controller",
    "input-keyboard": "Keyboard",
    "input-mouse": "Mouse",
    "input-tablet": "Tablet",
    "audio-headset": "Headset",
    "audio-headphones": "Headphones",
    "audio-card": "Speaker",
    "phone": "Phone",
    "computer": "Computer",
}
SCAN_FOR = 30  # seconds of discovery after the Bluetooth screen last asked


class Bluetooth:
    def __init__(self, log):
        self.log = log
        self.lock = threading.Lock()
        self.power_lock = threading.Lock()
        self.proc = None
        self.output = ""  # recent bluetoothctl output, for prompts and results
        self.total = 0  # characters of output so far, including trimmed ones
        self.busy = {}  # address -> "pairing" | "connecting" | "disconnecting"
        self.errors = {}  # address -> what went wrong last time
        self.code = None  # {"address", "code"} a keyboard wants typed
        self.scan_until = 0.0
        self.scanning = False

    # ---------- the bluetoothctl process ----------

    def ctl(self, command):
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                self.proc = subprocess.Popen(
                    ["bluetoothctl"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, env={**os.environ, "TERM": "dumb"},
                )
                threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
            try:
                self.proc.stdin.write(f"{command}\n".encode())
                self.proc.stdin.flush()
            except OSError:
                pass

    def _read(self, proc):
        while True:
            chunk = os.read(proc.stdout.fileno(), 4096)
            if not chunk:
                return
            text = ANSI.sub("", chunk.decode(errors="replace"))
            self.output = (self.output + text)[-8000:]
            self.total += len(text)
            for line in text.split("\n"):
                if re.search(r"\[agent\]|Failed to (pair|connect)|not available", line):
                    self.log(f"bluetooth: {line.strip()}")
            self._agent(text)

    def _agent(self, text):
        """Answers pairing questions: yes to confirm and authorize; remember display codes."""
        if re.search(r"\(yes/no\)", text):
            self.ctl("yes")
        elif "Enter PIN code" in text:
            self.ctl("0000")  # older devices with a fixed PIN
        elif "Enter passkey" in text:
            self.ctl("0")
        code = re.search(r"(?:Passkey|PIN code):\s*(\d+)", text)
        if code:
            pairing = next((a for a, s in self.busy.items() if s == "pairing"), None)
            self.code = {"address": pairing, "code": code.group(1)}

    # ---------- state, from D-Bus ----------

    def objects(self):
        """BlueZ's objects: {path: {interface: {property: value}}}."""
        try:
            import dbus  # python3-dbus; imported here so wiid starts without it
            # introspect=False: introspecting is a call of its own, with D-Bus's
            # 25-second default timeout.
            manager = dbus.Interface(dbus.SystemBus().get_object("org.bluez", "/", introspect=False),
                                     "org.freedesktop.DBus.ObjectManager")
            found = manager.GetManagedObjects(timeout=5)
        except Exception:  # no BlueZ, no adapter, no python3-dbus
            return {}
        return {str(path): {str(i): dict(props) for i, props in ifaces.items()}
                for path, ifaces in found.items()}

    @staticmethod
    def props(obj, iface):
        return obj.get(iface, {})

    def status(self):
        # Without an adapter, BlueZ never starts (its service requires one), and
        # asking it over D-Bus waits for it to start: check the kernel instead.
        if not shutil.which("bluetoothctl") or not any(Path("/sys/class/bluetooth").glob("hci*")):
            return {"available": False}
        objects = self.objects()
        adapter = next((self.props(o, "org.bluez.Adapter1") for o in objects.values()
                        if "org.bluez.Adapter1" in o), None)
        if not adapter:
            return {"available": False}
        if self.scanning and time.time() > self.scan_until:
            self.scanning = False
            self.ctl("scan off")
        devices = []
        for obj in objects.values():
            d = self.props(obj, "org.bluez.Device1")
            if not d:
                continue
            address = str(d.get("Address"))
            name = str(d.get("Name") or d.get("Alias") or "")
            if not name or name.replace("-", ":") == address:
                continue  # nameless devices are mostly beacons nobody wants
            if not d.get("Paired") and d.get("RSSI") is None:
                continue  # not seen in this scan
            devices.append({
                "address": address,
                "name": name,
                "kind": KINDS.get(str(d.get("Icon") or ""), ""),
                "paired": bool(d.get("Paired")),
                "connected": bool(d.get("Connected")),
                "signal": None if d.get("RSSI") is None else int(d.get("RSSI")),
                "busy": self.busy.get(address),
                "error": self.errors.get(address),
            })
        devices.sort(key=lambda d: (not d["paired"], not d["connected"], -(d["signal"] or -999)))
        code = self.code if self.code and self.busy.get(self.code["address"]) == "pairing" else None
        return {
            "available": True,
            "on": bool(adapter.get("Powered")),
            "scanning": bool(adapter.get("Discovering")),
            "devices": devices,
            "code": code,
        }

    # ---------- actions ----------

    def set_on(self, on):
        """Waits until the adapter is on (or off): asking again while it's still
        switching is refused, so a quick off-and-on would otherwise stay off."""
        self.scanning = False  # powering off ends discovery
        with self.power_lock:
            for _ in range(3):
                self.ctl("power on" if on else "power off")
                end = time.time() + 3
                while time.time() < end:
                    adapter = next((o["org.bluez.Adapter1"] for o in self.objects().values()
                                    if "org.bluez.Adapter1" in o), {})
                    if bool(adapter.get("Powered")) == on:
                        return True
                    time.sleep(0.3)
        return False

    def scan(self):
        """Look for devices for the next SCAN_FOR seconds (the screen keeps asking)."""
        self.scan_until = time.time() + SCAN_FOR
        if not self.scanning:
            self.scanning = True
            self.ctl("scan on")
        return True

    def _device(self, address):
        for obj in self.objects().values():
            d = self.props(obj, "org.bluez.Device1")
            if str(d.get("Address")) == address:
                return d
        return {}

    def _wait(self, address, prop, want, seconds, failure):
        mark = self.total
        end = time.time() + seconds
        while time.time() < end:
            if bool(self._device(address).get(prop)) == want:
                return True
            since = self.total - mark
            if since and re.search(failure, self.output[-since:]):
                return False
            time.sleep(0.5)
        return False

    def _task(self, address, state, work):
        if not re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", address or "") or address in self.busy:
            return False
        self.busy[address] = state
        self.errors.pop(address, None)

        def go():
            try:
                error = work()
                if error:
                    self.errors[address] = error
            finally:
                self.busy.pop(address, None)

        threading.Thread(target=go, daemon=True).start()
        return True

    def pair(self, address):
        def work():
            self.log(f"bluetooth: pairing {address}")
            self.ctl(f"pair {address}")
            if not self._wait(address, "Paired", True, 45, r"Failed to pair|not available"):
                self.ctl(f"cancel-pairing {address}")
                return "Couldn't pair. Put it in pairing mode and try again."
            # Trusted devices may reconnect by themselves, like a controller waking up.
            self.ctl(f"trust {address}")
            self.busy[address] = "connecting"
            self.ctl(f"connect {address}")
            if not self._wait(address, "Connected", True, 20, r"Failed to connect|not available"):
                return "Paired, but it didn't connect. Press A to try again."
            return None

        return self._task(address, "pairing", work)

    def connect(self, address):
        def work():
            self.ctl(f"connect {address}")
            if not self._wait(address, "Connected", True, 20, r"Failed to connect|not available"):
                return "Couldn't connect. Make sure it's on and nearby."
            return None

        return self._task(address, "connecting", work)

    def disconnect(self, address):
        def work():
            self.ctl(f"disconnect {address}")
            self._wait(address, "Connected", False, 10, r"Failed to disconnect")
            return None

        return self._task(address, "disconnecting", work)

    def forget(self, address):
        if not re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", address or ""):
            return False
        self.log(f"bluetooth: forgetting {address}")
        self.ctl(f"remove {address}")
        self.errors.pop(address, None)
        return True

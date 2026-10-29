#!/usr/bin/env python3
"""wiid: the wii-os session daemon.

Runs inside cage as its only client process. It
  - serves the menu UI and a small JSON API on 127.0.0.1,
  - keeps the menu browser running and launches channels on top of it,
  - turns controllers into keyboard input, so the menu and every channel
    are driven the same way, and handles the Home button itself.
"""
import json
import os
import signal
import socket
import subprocess
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import evdev
from evdev import UInput, ecodes as e

from devtools import launch_with_scripts
from home import Home
from messages import Messages
from network import Bluetooth, Wifi
from settings import Settings
from updates import Updater

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "ui"
CHANNELS_FILE = ROOT / "wiid" / "channels.json"
STATE_DIR = Path.home() / ".local/share/wii-os"
PORT = 8770
MENU_URL = f"http://127.0.0.1:{PORT}/"

CHROMIUM_FLAGS = [
    "--ozone-platform=wayland",
    "--kiosk",
    "--no-first-run",
    "--noerrdialogs",
    "--disable-infobars",
    "--password-store=basic",
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    "--check-for-update-interval=31536000",
    # BackForwardCache: under cage, a page restored from it on "back" draws
    # as a blank white screen; a normal reload draws fine.
    "--disable-features=Translate,MediaRouter,BackForwardCache",
    "--enable-features=AcceleratedVideoDecodeLinuxGL",
]


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def chromium(profile, url, extra=(), browser="chromium", scripts=()):
    cmd = [browser, *CHROMIUM_FLAGS, f"--user-data-dir={STATE_DIR / 'profiles' / profile}", *extra, f"--app={url}"]
    if scripts:
        # The DevTools pipe makes Chrome report itself as automated
        # (navigator.webdriver), and sites like Google then treat the person
        # using it as a bot. The pipe only adds our keyboard, so turn that off.
        cmd.insert(1, "--disable-blink-features=AutomationControlled")
        sources = [(UI_DIR / name).read_text(encoding="utf-8") for name in scripts]
        return launch_with_scripts(cmd, sources, log, on_message=page_message)
    return subprocess.Popen(cmd, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(proc, timeout=4):
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


SUSPEND_LIMIT = 30 * 60  # seconds a paused channel waits before it's closed for good
SAVER_URL = f"http://127.0.0.1:{PORT}/screensaver.html"


def process_tree(root):
    """root and all its descendants. Signals go to each of them, because
    Flatpak apps leave the process group they were started in."""
    children = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        ppid = int(stat.rsplit(")", 1)[1].split()[1])
        children.setdefault(ppid, []).append(int(entry.name))
    tree, todo = [], [root]
    while todo:
        pid = todo.pop()
        tree.append(pid)
        todo.extend(children.get(pid, []))
    return tree


def signal_tree(root, sig):
    for pid in process_tree(root):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def media_playing():
    """Whether any app is playing sound right now (counts as activity, so a
    long movie doesn't bring up the screen saver)."""
    try:
        out = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=5).stdout
        objects = json.loads(out)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False
    for obj in objects:
        info = obj.get("info") or {}
        props = info.get("props") or {}
        if props.get("media.class") == "Stream/Output/Audio" and info.get("state") == "running":
            return True
    return False


class Running:
    """A channel's process tree, which can be paused and closed."""

    def __init__(self, channel, proc):
        self.channel = channel
        self.id = channel["id"]
        self.proc = proc
        self.paused_at = None

    def alive(self):
        return self.proc.poll() is None

    def pause(self):
        signal_tree(self.proc.pid, signal.SIGSTOP)
        self.paused_at = time.time()

    def resume(self):
        signal_tree(self.proc.pid, signal.SIGCONT)
        self.paused_at = None

    def close(self):
        if self.paused_at:
            # A stopped process only acts on SIGTERM once it's running again.
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            signal_tree(self.proc.pid, signal.SIGCONT)
        stop(self.proc)
        if self.channel.get("stop"):
            subprocess.run(self.channel["stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Session:
    """The menu browser, the channels shown over it, and the screen saver.

    cage shows the newest window on top, so a channel covers the menu. With
    suspend on, Home pauses the channel instead of closing it (freezing all
    its processes) and opens a fresh menu window over it. Opening that channel
    again closes the menu window, which reveals the channel, and unpauses it.
    A paused channel is closed for good after SUSPEND_LIMIT, or as soon as a
    different channel opens.
    """

    def __init__(self):
        # Re-entrant: the shutdown signal handler runs on the same thread as run().
        self.lock = threading.RLock()
        self.menu = None
        self.menu_wanted = True  # False while a resumed channel is where the menu was
        self.menu_starts = 0
        self.current = None  # the channel on screen
        self.paused = None  # a suspended channel, behind the menu
        self.home_presses = 0  # lets the menu notice Home while its own shop is open
        self.last_input = time.time()
        self.saver = None  # the screen saver's window
        self.saver_grace = 0  # until then, input doesn't close the screen saver
        self.saver_closed_at = 0

    def run(self):
        display = Path(os.environ["XDG_RUNTIME_DIR"]) / os.environ["WAYLAND_DISPLAY"]
        while True:
            if not display.exists():
                # cage is shutting down and waits for us to exit first.
                log("display gone, exiting")
                return
            with self.lock:
                if self.menu_wanted and (self.menu is None or self.menu.poll() is not None):
                    self._start_menu()
                if self.current and not self.current.alive():
                    log(f"channel {self.current.id} exited")
                    self.current = None
                    self._controls(None)
                    self.menu_wanted = True
                if self.paused and (not self.paused.alive()
                                    or time.time() - self.paused.paused_at > SUSPEND_LIMIT):
                    log(f"closing paused channel {self.paused.id}")
                    self.paused.close()
                    self.paused = None
            self._screen_saver_tick()
            time.sleep(1)

    def _start_menu(self):
        # Only the first menu of a session shows the welcome screen.
        url = MENU_URL if self.menu_starts == 0 else MENU_URL + "?return=1"
        log("starting menu")
        self.menu = chromium("menu", url, scripts=["volume.js"])
        self.menu_starts += 1

    def _controls(self, channel):
        # Game streaming needs the real controller, not arrow keys.
        CONTROLLERS.set_raw(bool(channel and channel.get("raw_controller")))
        POINTER.set_enabled(bool(channel and channel.get("pointer")))

    def launch(self, channel_id):
        channel = HOME.channel(channel_id)
        if channel is None or channel.get("builtin"):
            return False  # built-in channels (shop, settings) run inside the menu itself
        with self.lock:
            if self.paused and self.paused.id == channel_id:
                log(f"resuming {channel_id}")
                self.current, self.paused = self.paused, None
                self.current.resume()
                self.menu_wanted = False
                stop(self.menu)  # the channel's window is right underneath
                self.menu = None
                self._controls(channel)
                return True
            for old in (self.paused, self.current):
                if old:
                    log(f"closing {old.id}")
                    old.close()
            self.paused = self.current = None
            log(f"launching {channel_id}")
            self.current = Running(channel, self._start(channel))
            self._controls(channel)
        return True

    def _start(self, channel):
        if "command" in channel:
            # A native app rather than a web page.
            return subprocess.Popen(channel["command"], start_new_session=True,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        extra = [f"--user-agent={channel['user_agent']}"] if channel.get("user_agent") else []
        if channel.get("spatial_navigation"):
            extra.append("--enable-spatial-navigation")  # arrow keys move between links
        # Google Chrome carries Widevine DRM; Debian's Chromium does not.
        browser = "google-chrome-stable" if channel.get("drm") else "chromium"
        scripts = ["volume.js"]  # shows the volume when it changes
        if channel.get("keyboard"):
            scripts.append("osk.js")  # on-screen keyboard for ordinary web forms
        if channel.get("browsing"):
            scripts.append("browser-helper.js")  # B = back, Y = start page
        if channel.get("pointer"):
            scripts.append("pointer.js")  # draws the hand for the right-stick pointer
        return chromium(channel["id"], channel["url"], extra, browser, scripts)

    def home(self):
        with self.lock:
            self.home_presses += 1
            channel = self.current
            if channel is None:
                return
            self.current = None
            self._controls(None)
            # Game streams would lose their connection while frozen.
            if SETTINGS.get("suspend") and not channel.channel.get("raw_controller"):
                log(f"home: pausing {channel.id}")
                channel.pause()
                self.paused = channel
                stop(self.menu)  # the old menu is under the channel; open a new one on top
                self.menu = None
                self._start_menu()
            else:
                log(f"home: closing {channel.id}")
                channel.close()
            self.menu_wanted = True

    def restart_menu(self):
        with self.lock:
            for old in (self.paused, self.current):
                if old:
                    old.close()
            self.paused = self.current = None
            self._controls(None)
            self.menu_wanted = True
            stop(self.menu)  # run() starts a fresh one
            self.menu = None

    def show_volume(self, percent, muted):
        """Draws the volume over whatever is on screen (ui/volume.js). Native
        apps have no page to draw on, so they show nothing."""
        with self.lock:
            proc = self.current.proc if self.current else self.menu
        devtools = getattr(proc, "devtools", None)
        if devtools:
            devtools.call("__wiiVolume", percent, muted)

    def state(self):
        with self.lock:
            return {
                "running": self.current.id if self.current else None,
                "paused": self.paused.id if self.paused else None,
                "home_presses": self.home_presses,
            }

    # ---------- screen saver ----------

    def input_seen(self):
        """Called for every real controller input. True means it only woke the
        screen saver, so it shouldn't reach the app."""
        now = time.time()
        self.last_input = now
        saver = self.saver
        if saver is None:
            return now - self.saver_closed_at < 0.6  # the rest of the waking press
        if now < self.saver_grace:
            return True
        self.saver = None
        self.saver_closed_at = now
        log("screen saver off")
        threading.Thread(target=stop, args=(saver,), daemon=True).start()
        UPDATER.check_soon()  # someone is back: a good moment to look for updates
        return True

    def show_screen_saver(self, grace=0.0):
        if self.saver is None or self.saver.poll() is not None:
            self.saver = chromium("screensaver", SAVER_URL)
            self.saver_grace = time.time() + grace

    def _screen_saver_tick(self):
        if self.saver is not None:
            if self.saver.poll() is not None:
                self.saver = None
            return
        hours = SETTINGS.get("screensaver_hours")
        if not hours or time.time() - self.last_input < hours * 3600:
            return
        if media_playing():
            self.last_input = time.time()  # watching something counts as activity
            return
        log(f"no input for {hours} h: screen saver on")
        self.show_screen_saver()


SESSION = Session()
SETTINGS = Settings(STATE_DIR)
MESSAGES = Messages(STATE_DIR)
HOME = Home(CHANNELS_FILE, STATE_DIR, log, MESSAGES)
# After an update, exit: cage exits with us and getty starts the new version.
UPDATER = Updater(ROOT, STATE_DIR, log, MESSAGES, on_installed=lambda: os.kill(os.getpid(), signal.SIGTERM))
WIFI = Wifi(log)
BLUETOOTH = Bluetooth(log)


def system_info():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # picks the outgoing interface; nothing is sent
        ip = s.getsockname()[0]
    except OSError:
        ip = None
    finally:
        s.close()
    return {"hostname": socket.gethostname(), "ip": ip, "version": UPDATER.version}


def power(action):
    if action == "restart-menu":
        threading.Thread(target=SESSION.restart_menu, daemon=True).start()
    elif action in ("poweroff", "reboot"):
        subprocess.Popen(["sudo", "-n", "/usr/bin/systemctl", action])
    else:
        return False
    return True


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/api/home":
            self.send_json(HOME.layout())
        elif self.path == "/api/shop":
            self.send_json(HOME.listing())
        elif self.path == "/api/messages":
            self.send_json(MESSAGES.all())
        elif self.path == "/api/state":
            self.send_json(SESSION.state())
        elif self.path == "/api/system":
            self.send_json(system_info())
        elif self.path == "/api/update":
            self.send_json(UPDATER.state())
        elif self.path == "/api/settings":
            self.send_json(SETTINGS.describe())
        elif self.path == "/api/wifi":
            self.send_json(WIFI.status())
        elif self.path == "/api/bluetooth":
            self.send_json(BLUETOOTH.status())
        elif self.path == "/api/update?all=1":  # including a declined version
            self.send_json(UPDATER.state(include_declined=True))
        else:
            super().do_GET()

    def do_POST(self):
        body = self.read_json()
        if self.path == "/api/update/check":
            self.send_json(UPDATER.check_now())
            return
        if self.path == "/api/wifi/connect":  # waits until it has connected or failed
            result = WIFI.connect(body.get("ssid"), body.get("password") or None)
            self.send_json(result, 200 if result["ok"] else 400)
            return
        if self.path == "/api/update/decline":
            UPDATER.decline()
            ok = True
        elif self.path == "/api/update/install":
            ok = UPDATER.install()
        elif self.path == "/api/home":
            ok = HOME.save_slots(body.get("slots", []))
        elif self.path == "/api/settings":
            ok = SETTINGS.update(body)
        elif self.path == "/api/screensaver":  # "Try it" in Settings
            SESSION.show_screen_saver(grace=1.5)  # the A press that started it mustn't end it
            ok = True
        elif self.path == "/api/shop/install":
            ok = HOME.install(body.get("id"))
        elif self.path == "/api/channels/remove":
            ok = HOME.remove(body.get("id"))
        elif self.path == "/api/messages/read":
            MESSAGES.mark_read(body.get("id"))
            ok = True
        elif self.path == "/api/launch":
            ok = SESSION.launch(body.get("id"))
        elif self.path == "/api/go-home":
            SESSION.home()
            ok = True
        elif self.path == "/api/wifi/on":
            ok = WIFI.set_on(bool(body.get("on")))
        elif self.path == "/api/wifi/scan":
            ok = WIFI.scan()
        elif self.path == "/api/wifi/forget":
            ok = WIFI.forget(body.get("ssid"))
        elif self.path == "/api/bluetooth/on":
            ok = BLUETOOTH.set_on(bool(body.get("on")))
        elif self.path == "/api/bluetooth/scan":
            ok = BLUETOOTH.scan()
        elif self.path in ("/api/bluetooth/pair", "/api/bluetooth/connect",
                           "/api/bluetooth/disconnect", "/api/bluetooth/forget"):
            ok = getattr(BLUETOOTH, self.path.rsplit("/", 1)[1])(body.get("address"))
        elif self.path == "/api/power":
            ok = power(body.get("action"))
        else:
            self.send_json({"error": "not found"}, 404)
            return
        self.send_json({"ok": ok}, 200 if ok else 400)


# Controller -> keyboard. Held keys auto-repeat in the browser, like a remote.
BUTTON_KEYS = {
    e.BTN_SOUTH: e.KEY_ENTER,      # A: select
    e.BTN_EAST: e.KEY_ESC,         # B: back
    e.BTN_X: e.KEY_X,              # X: move a channel (xpad reports X as BTN_X)
    e.BTN_Y: e.KEY_Y,              # Y: channel options
    e.BTN_START: e.KEY_ENTER,
    e.BTN_TL: e.KEY_PAGEUP,        # bumpers: previous / next page
    e.BTN_TR: e.KEY_PAGEDOWN,
}
HAT_KEYS = {
    e.ABS_HAT0X: (e.KEY_LEFT, e.KEY_RIGHT),
    e.ABS_HAT0Y: (e.KEY_UP, e.KEY_DOWN),
}
STICK_KEYS = {
    e.ABS_X: (e.KEY_LEFT, e.KEY_RIGHT),
    e.ABS_Y: (e.KEY_UP, e.KEY_DOWN),
}
STICK_ON, STICK_OFF = 0.6, 0.35  # hysteresis, as a fraction of full tilt


HOME_HOLD = 1.0  # seconds Home must be held to leave a raw-controller channel


class Keyboard:
    def __init__(self):
        keys = set(BUTTON_KEYS.values())
        for pair in (*HAT_KEYS.values(), *STICK_KEYS.values()):
            keys.update(pair)
        self.keys = sorted(keys)
        self.ui = UInput({e.EV_KEY: self.keys}, name="wii-os controller keys")
        self.lock = threading.Lock()

    def set(self, key, down):
        with self.lock:
            self.ui.write(e.EV_KEY, key, 1 if down else 0)
            self.ui.syn()

    def release_all(self):
        for key in self.keys:
            self.set(key, False)


class Controllers:
    """The open controllers, and whether a channel has them raw.

    Normally wiid grabs each controller (so apps never see it) and turns it
    into keys. A raw-controller channel, such as game streaming, gets the
    controller itself; wiid then only watches for a held Home button.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.devices = {}  # path -> InputDevice (which isn't hashable)
        self.raw = False
        self.keyboard = None

    def add(self, dev):
        with self.lock:
            self.devices[dev.path] = dev
            if not self.raw:
                dev.grab()

    def remove(self, dev):
        with self.lock:
            self.devices.pop(dev.path, None)

    def set_raw(self, raw):
        with self.lock:
            if raw == self.raw:
                return
            self.raw = raw
            for dev in self.devices.values():
                try:
                    dev.ungrab() if raw else dev.grab()
                except OSError:
                    pass
        if raw and self.keyboard:
            self.keyboard.release_all()  # no arrow key left held down
        log("controller: raw for the channel" if raw else "controller: menu keys")


CONTROLLERS = Controllers()

RIGHT_STICK = {e.ABS_RX: "x", e.ABS_RY: "y"}
POINTER_SPEED = 26  # pixels per tick at full tilt
POINTER_DEADZONE = 0.18
POINTER_HZ = 60


def pointer_curve(tilt):
    """Stick tilt -> speed, with a dead zone and finer control near the centre."""
    a = abs(tilt)
    if a < POINTER_DEADZONE:
        return 0.0
    speed = ((a - POINTER_DEADZONE) / (1 - POINTER_DEADZONE)) ** 2
    return speed if tilt > 0 else -speed


class Pointer:
    """A mouse driven by the right stick, for channels that want one (the web).

    The system cursor is invisible on the TV, so the page draws the Wii hand
    where this pointer is (ui/pointer.js). A clicks while the pointer was the
    last thing moved; the D-pad hands A back to link-by-link navigation. The
    pointer rests while the on-screen keyboard is open.
    """

    def __init__(self):
        self.mouse = UInput({e.EV_REL: [e.REL_X, e.REL_Y], e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT]},
                            name="wii-os pointer")
        self.lock = threading.Lock()
        self.enabled = False  # the running channel wants a pointer
        self.keyboard_open = False  # the on-screen keyboard has the controller
        self.active = False  # the pointer was the last thing moved, so A clicks
        self.tilt = {}  # controller path -> (x, y) of its right stick
        self.rest = [0.0, 0.0]  # sub-pixel movement carried to the next tick
        threading.Thread(target=self._run, daemon=True).start()

    def set_enabled(self, enabled):
        self.enabled = enabled
        self.keyboard_open = False
        self.active = False

    def usable(self):
        return self.enabled and not self.keyboard_open and not CONTROLLERS.raw

    def stick(self, path, axis, tilt):
        x, y = self.tilt.get(path, (0.0, 0.0))
        self.tilt[path] = (tilt, y) if axis == "x" else (x, tilt)

    def button(self, down):
        with self.lock:
            self.mouse.write(e.EV_KEY, e.BTN_LEFT, 1 if down else 0)
            self.mouse.syn()

    def _run(self):
        while True:
            time.sleep(1 / POINTER_HZ)
            if not self.usable():
                continue
            dx = sum(pointer_curve(x) for x, _ in list(self.tilt.values())) * POINTER_SPEED + self.rest[0]
            dy = sum(pointer_curve(y) for _, y in list(self.tilt.values())) * POINTER_SPEED + self.rest[1]
            step_x, step_y = int(dx), int(dy)
            self.rest = [dx - step_x, dy - step_y]
            if step_x or step_y:
                self.active = True
                with self.lock:
                    self.mouse.write(e.EV_REL, e.REL_X, step_x)
                    self.mouse.write(e.EV_REL, e.REL_Y, step_y)
                    self.mouse.syn()


POINTER = Pointer()


def page_message(data):
    """Messages from scripts injected into channel pages (see ui/osk.js)."""
    if "keyboard" in data:
        POINTER.keyboard_open = bool(data["keyboard"])
        log(f"page: on-screen keyboard {'open' if POINTER.keyboard_open else 'closed'}")
        if POINTER.keyboard_open:
            POINTER.active = False


def meaningful(ev, ranges):
    """A button, or a real push of a stick; not the small jitter of an
    untouched stick, which would keep the screen saver away forever."""
    if ev.type == e.EV_KEY:
        return True
    if ev.type != e.EV_ABS or ev.code not in ranges:
        return False
    lo, hi = ranges[ev.code]
    if hi - lo <= 2:  # the D-pad
        return ev.value != 0
    return abs(ev.value - (lo + hi) / 2) / ((hi - lo) / 2) > 0.3


def is_gamepad(dev):
    caps = dev.capabilities()
    return e.BTN_SOUTH in caps.get(e.EV_KEY, []) and e.EV_ABS in caps


def read_gamepad(path, keyboard, active):
    try:
        dev = evdev.InputDevice(path)
        CONTROLLERS.add(dev)  # grabbed, so the browser doesn't also see the raw gamepad
    except OSError as err:
        log(f"cannot open {path}: {err}")
        active.discard(path)
        return
    log(f"controller connected: {dev.name}")
    ranges = {code: (info.min, info.max) for code, info in dev.capabilities()[e.EV_ABS]}
    stick = {}  # axis -> key currently held by that axis
    hold = None  # timer for a held Home button
    a_clicks = False  # whether the A press in progress is a pointer click
    try:
        for ev in dev.read_loop():
            if meaningful(ev, ranges) and SESSION.input_seen():
                continue  # it only woke the screen saver
            if CONTROLLERS.raw:
                # The channel reads the controller itself. A tap of Home goes to
                # the game (the PC's guide button); holding it comes back here.
                if ev.type == e.EV_KEY and ev.code == e.BTN_MODE:
                    if ev.value == 1:
                        hold = threading.Timer(HOME_HOLD, SESSION.home)
                        hold.start()
                    elif ev.value == 0 and hold:
                        hold.cancel()
                continue
            if ev.type == e.EV_KEY:
                if ev.code == e.BTN_MODE:
                    if ev.value == 1:
                        threading.Thread(target=SESSION.home, daemon=True).start()
                elif ev.code == e.BTN_SOUTH and ev.value in (0, 1):
                    # A clicks at the pointer if that's what was moved last.
                    if ev.value == 1:
                        a_clicks = POINTER.usable() and POINTER.active
                    if a_clicks:
                        POINTER.button(ev.value == 1)
                    else:
                        keyboard.set(e.KEY_ENTER, ev.value == 1)
                elif ev.code in BUTTON_KEYS and ev.value in (0, 1):
                    keyboard.set(BUTTON_KEYS[ev.code], ev.value == 1)
            elif ev.type == e.EV_ABS and ev.code in RIGHT_STICK:
                lo, hi = ranges[ev.code]
                POINTER.stick(path, RIGHT_STICK[ev.code], (ev.value - (lo + hi) / 2) / ((hi - lo) / 2))
            elif ev.type == e.EV_ABS and ev.code in HAT_KEYS:
                neg, pos = HAT_KEYS[ev.code]
                keyboard.set(neg, ev.value < 0)
                keyboard.set(pos, ev.value > 0)
                if ev.value:
                    POINTER.active = False  # back to link-by-link navigation
            elif ev.type == e.EV_ABS and ev.code in STICK_KEYS:
                lo, hi = ranges[ev.code]
                mid, half = (lo + hi) / 2, (hi - lo) / 2
                tilt = (ev.value - mid) / half
                neg, pos = STICK_KEYS[ev.code]
                held = stick.get(ev.code)
                want = neg if tilt < -STICK_ON else pos if tilt > STICK_ON else None
                if held and abs(tilt) > STICK_OFF and (want is None or want == held):
                    continue  # still inside the hysteresis band
                if want != held:
                    if held:
                        keyboard.set(held, False)
                    if want:
                        keyboard.set(want, True)
                        POINTER.active = False
                    stick[ev.code] = want
    except OSError:
        log(f"controller disconnected: {dev.name}")
    finally:
        CONTROLLERS.remove(dev)
        POINTER.tilt.pop(path, None)
        if hold:
            hold.cancel()
        for key in stick.values():
            if key:
                keyboard.set(key, False)
        active.discard(path)


# TV remote and keyboard keys -> the controller's keys. Remotes send TV keys
# (Select, Back, Menu) that the menu and channels don't know.
REMOTE_KEYS = {
    e.KEY_SELECT: e.KEY_ENTER,
    e.KEY_OK: e.KEY_ENTER,
    e.KEY_PLAYPAUSE: e.KEY_ENTER,  # Play/Pause: a second OK
    e.KEY_BACK: e.KEY_ESC,
    e.KEY_MENU: e.KEY_Y,           # Menu: channel options
    e.KEY_COMPOSE: e.KEY_Y,        # what many remotes' Menu button sends
}
VOLUME_KEYS = {
    e.KEY_VOLUMEUP: ["set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", "5%+"],
    e.KEY_VOLUMEDOWN: ["set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"],
    e.KEY_MUTE: ["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"],
}


class Volume:
    """Volume changes, made one at a time by wpctl and then shown on screen.
    At most two wait, so a held button stops soon after it's let go."""

    def __init__(self):
        self.cond = threading.Condition()
        self.todo = []
        threading.Thread(target=self._run, daemon=True).start()

    def press(self, key):
        with self.cond:
            if len(self.todo) < 2:
                self.todo.append(VOLUME_KEYS[key])
                self.cond.notify()

    def _run(self):
        while True:
            with self.cond:
                while not self.todo:
                    self.cond.wait()
                args = self.todo.pop(0)
            try:
                subprocess.run(["wpctl", *args], timeout=3)
                # "Volume: 0.55", or "Volume: 0.55 [MUTED]"
                out = subprocess.run(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"],
                                     capture_output=True, text=True, timeout=3).stdout
                percent = round(float(out.split()[1]) * 100)
            except (OSError, subprocess.TimeoutExpired, IndexError, ValueError):
                continue
            SESSION.show_volume(percent, "MUTED" in out)


VOLUME = Volume()


def is_keyboard(dev):
    keys = dev.capabilities().get(e.EV_KEY, [])
    return (e.KEY_ENTER in keys or e.KEY_SELECT in keys) and not dev.name.startswith("wii-os ")


def read_keyboard(path, active):
    """A keyboard or TV remote, passed on through a copy of itself with the
    remote keys swapped for the controller's. Back held for HOME_HOLD is Home,
    for remotes without a Home button (a tap is Esc, on release)."""
    try:
        dev = evdev.InputDevice(path)
        keys = set(dev.capabilities()[e.EV_KEY]) | set(REMOTE_KEYS.values())
        copy = UInput({e.EV_KEY: sorted(keys)}, name="wii-os keyboard")
        dev.grab()
    except OSError as err:
        log(f"cannot open {path}: {err}")
        active.discard(path)
        return
    log(f"keyboard connected: {dev.name}")
    swallowed = set()  # keys whose press only woke the screen saver
    back = None  # timer for a held Back

    def send(key, value):
        copy.write(e.EV_KEY, key, value)
        copy.syn()

    try:
        for ev in dev.read_loop():
            if ev.type != e.EV_KEY:
                continue
            if ev.value == 1 and SESSION.input_seen():
                swallowed.add(ev.code)
                continue
            if ev.code in swallowed:
                if ev.value == 0:
                    swallowed.discard(ev.code)
                continue
            if ev.code in (e.KEY_HOMEPAGE, e.KEY_POWER):  # Power is a Home button too
                if ev.value == 1:
                    threading.Thread(target=SESSION.home, daemon=True).start()
            elif ev.code == e.KEY_BACK:
                if ev.value == 1:
                    back = threading.Timer(HOME_HOLD, SESSION.home)
                    back.start()
                elif ev.value == 0 and back and not back.finished.is_set():
                    back.cancel()  # a tap, not a hold
                    send(e.KEY_ESC, 1)
                    send(e.KEY_ESC, 0)
            elif ev.code in VOLUME_KEYS:
                if ev.value in (1, 2):
                    VOLUME.press(ev.code)
            else:
                send(REMOTE_KEYS.get(ev.code, ev.code), ev.value)
    except OSError:
        log(f"keyboard disconnected: {dev.name}")
    finally:
        if back:
            back.cancel()
        copy.close()
        active.discard(path)


def watch_gamepads():
    keyboard = Keyboard()
    CONTROLLERS.keyboard = keyboard
    active = set()
    while True:
        for path in evdev.list_devices():
            if path in active:
                continue
            try:
                dev = evdev.InputDevice(path)
                pad = is_gamepad(dev) and dev.name != keyboard.ui.name
                keys = not pad and is_keyboard(dev)
                dev.close()
            except OSError:
                continue
            if pad:
                active.add(path)
                threading.Thread(target=read_gamepad, args=(path, keyboard, active), daemon=True).start()
            elif keys:
                active.add(path)
                threading.Thread(target=read_keyboard, args=(path, active), daemon=True).start()
        time.sleep(2)


def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not MESSAGES.all()["messages"]:
        MESSAGES.add(
            "Welcome to Wii-OS",
            "Get more channels from the Channel Shop. Press X on a channel to move it, "
            "and Y for its options. Home pauses a channel so you can pick up where "
            "you left off. Updates and new channels are recorded here.",
            kind="welcome",
        )
    UPDATER.record_version()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(UI_DIR)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"serving menu on {MENU_URL}")
    threading.Thread(target=watch_gamepads, daemon=True).start()
    threading.Thread(target=UPDATER.loop, daemon=True).start()

    def shutdown(*_):
        SESSION.restart_menu()  # closes every channel, paused ones too, and the menu
        stop(SESSION.saver)
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    SESSION.run()
    shutdown()


if __name__ == "__main__":
    main()

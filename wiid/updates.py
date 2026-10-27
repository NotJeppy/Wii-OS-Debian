"""Update checks against the project's GitHub Releases.

No server of our own: every box asks GitHub's public API for the latest
release a few times a day. The menu shows the offer only while it is on
screen, and the user can decline a version. Installing runs
system/apply-update.sh through sudo, then restarts the TV session.
"""
import json
import re
import subprocess
import threading
import time
import urllib.request

CHECK_EVERY = 6 * 60 * 60  # seconds
# At startup the network may not be up yet: retry after these waits, then
# fall back to CHECK_EVERY.
STARTUP_RETRIES = [5, 10, 15, 30, 30, 60, 60, 120, 300]
MIN_GAP = 60  # never ask GitHub more often than this (its limit is 60 an hour)


def version_key(tag):
    return tuple(int(n) for n in re.findall(r"\d+", tag or ""))


def whats_new(body, limit=6):
    """The bullet points under the release notes' "What's new" heading."""
    notes, inside = [], False
    for line in (body or "").splitlines():
        if line.startswith("## "):
            inside = line[3:].strip().lower() == "what's new"
        elif inside and line.startswith("- "):
            notes.append(line[2:].strip())
    return notes[:limit]


class Updater:
    def __init__(self, root, state_dir, log, messages, on_installed):
        self.root = root
        self.log = log
        self.messages = messages
        self.on_installed = on_installed  # called after a successful install
        self.declined_file = state_dir / "update-declined"
        self.seen_version_file = state_dir / "last-version"
        self.lock = threading.Lock()
        self.wake = threading.Event()  # set by check_soon() to check ahead of schedule
        self.last_check = 0.0
        self.latest = None  # {"version", "notes"} of the newest release seen
        self.status = "idle"  # idle | installing | failed
        try:
            self.version = (root / "VERSION").read_text().strip()
            config = json.loads((root / "update.json").read_text())
        except (OSError, ValueError):
            self.version, config = None, {}
        self.repo = config.get("repo") or None
        # Overridable for testing against a stand-in server.
        self.api = config.get("api", "https://api.github.com")

    def record_version(self):
        """At startup: leave a message if this version is new since last time."""
        if not self.enabled:
            return
        try:
            last = self.seen_version_file.read_text().strip()
        except OSError:
            last = None
        if last and last != self.version:
            self.messages.add(
                "System updated",
                f"Wii-OS was updated from {last} to {self.version}.",
                kind="update-installed",
                data={"version": self.version},
            )
        self.seen_version_file.write_text(self.version)

    @property
    def enabled(self):
        # Dev copies (no version, or "dev") never update themselves.
        return bool(self.repo) and bool(version_key(self.version))

    def declined(self):
        try:
            return self.declined_file.read_text().strip()
        except OSError:
            return None

    def check(self):
        self.last_check = time.time()
        req = urllib.request.Request(
            f"{self.api}/repos/{self.repo}/releases/latest",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "wii-os-updater"},
        )
        with urllib.request.urlopen(req, timeout=20) as res:
            release = json.load(res)
        with self.lock:
            self.latest = {"version": release["tag_name"], "notes": whats_new(release.get("body"))}
        self.log(f"update check: installed {self.version}, latest {self.latest['version']}")
        offer = self.offer(include_declined=True)
        if offer and not self.messages.has("update-available", version=offer["version"]):
            # A lasting note, so the update can still be installed after "Not now".
            notes = "".join(f"\n• {n}" for n in offer["notes"])
            self.messages.add(
                "A system update is available",
                f"Wii-OS {offer['version']} is ready to install.{notes}",
                kind="update-available",
                data={"version": offer["version"]},
            )

    def loop(self):
        if not self.enabled:
            self.log("updates off (development copy)")
            return
        retries = list(STARTUP_RETRIES)
        while True:
            try:
                self.check()
                retries = []  # online: from now on, the regular schedule
            except Exception as err:  # offline, rate-limited, no releases yet...
                self.log(f"update check failed: {err}")
            wait = retries.pop(0) if retries else CHECK_EVERY
            if self.wake.wait(wait):  # check_soon() cut the wait short
                self.wake.clear()
                time.sleep(max(0.0, self.last_check + MIN_GAP - time.time()))

    def check_soon(self):
        """Check now instead of at the next scheduled time (waking the screen saver)."""
        if self.enabled:
            self.wake.set()

    def offer(self, include_declined=False):
        """The newer release to offer, or None."""
        with self.lock:
            latest = self.latest
        if not latest or version_key(latest["version"]) <= version_key(self.version):
            return None
        if not include_declined and latest["version"] == self.declined():
            return None
        return latest

    def state(self, include_declined=False):
        return {
            "enabled": self.enabled,
            "version": self.version,
            "available": self.offer(include_declined),
            "status": self.status,
        }

    def check_now(self):
        if not self.enabled:
            return {**self.state(), "error": "updates are off for this copy"}
        try:
            self.check()
        except Exception as err:
            return {**self.state(True), "error": str(err)}
        return self.state(include_declined=True)

    def decline(self):
        offer = self.offer(include_declined=True)
        if offer:
            self.declined_file.write_text(offer["version"])

    def install(self):
        offer = self.offer(include_declined=True)
        if not offer or self.status == "installing":
            return False
        self.status = "installing"
        threading.Thread(target=self._install, args=(offer["version"],), daemon=True).start()
        return True

    def _install(self, tag):
        self.log(f"installing update {tag}")
        script = self.root / "system" / "apply-update.sh"
        result = subprocess.run(["sudo", "-n", str(script), tag], capture_output=True, text=True)
        self.log(result.stdout.strip())
        if result.returncode != 0:
            self.log(f"update failed: {result.stderr.strip()}")
            self.status = "failed"
            return
        self.log(f"updated to {tag}; restarting the session")
        self.on_installed()

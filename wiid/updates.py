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
FIRST_CHECK_AFTER = 60


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
    def __init__(self, root, state_dir, log, on_installed):
        self.root = root
        self.log = log
        self.on_installed = on_installed  # called after a successful install
        self.declined_file = state_dir / "update-declined"
        self.lock = threading.Lock()
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
        req = urllib.request.Request(
            f"{self.api}/repos/{self.repo}/releases/latest",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "wii-os-updater"},
        )
        with urllib.request.urlopen(req, timeout=20) as res:
            release = json.load(res)
        with self.lock:
            self.latest = {"version": release["tag_name"], "notes": whats_new(release.get("body"))}
        self.log(f"update check: installed {self.version}, latest {self.latest['version']}")

    def loop(self):
        if not self.enabled:
            self.log("updates off (development copy)")
            return
        time.sleep(FIRST_CHECK_AFTER)
        while True:
            try:
                self.check()
            except Exception as err:  # offline, rate-limited, no releases yet...
                self.log(f"update check failed: {err}")
            time.sleep(CHECK_EVERY)

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

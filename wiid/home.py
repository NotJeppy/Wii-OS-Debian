"""The channels on the home menu: the shop's catalog, where each channel sits,
and getting channels from the shop.

The catalog (channels.json) ships with Wii-OS and grows with updates. Which
channels a user has, and in what order, lives in their own home.json: a list
of slots, 12 per page, each a channel id or null for an empty slot.
"""
import json
import subprocess
import threading

PER_PAGE = 12
SHOP = {
    "id": "shop",
    "name": "Channel Shop",
    "banner": "shop",
    "builtin": True,
    "description": "Get new channels for your home menu.",
}
SETTINGS = {
    "id": "settings",
    "name": "Settings",
    "banner": "settings",
    "builtin": True,
    "description": "Screen saver, suspend and other options.",
}
BUILTIN = {"shop": SHOP, "settings": SETTINGS}  # on every menu, and can't be deleted
DEFAULT_SLOTS = ["youtube", "shop", "settings"]
FLATHUB = "https://dl.flathub.org/repo/flathub.flatpakrepo"


class Home:
    def __init__(self, catalog_file, state_dir, log, messages):
        self.catalog_file = catalog_file
        self.layout_file = state_dir / "home.json"
        self.log = log
        self.messages = messages
        self.lock = threading.Lock()
        self.jobs = {}  # channel id -> "downloading" | "failed"

    def catalog(self):
        with open(self.catalog_file, encoding="utf-8") as f:
            return json.load(f)

    def channel(self, channel_id):
        if channel_id in BUILTIN:
            return BUILTIN[channel_id]
        return next((c for c in self.catalog() if c["id"] == channel_id), None)

    def known(self):
        return {c["id"] for c in self.catalog()} | set(BUILTIN)

    def slots(self):
        try:
            slots = json.loads(self.layout_file.read_text())["slots"]
        except (OSError, ValueError, KeyError):
            slots = list(DEFAULT_SLOTS)
        known = self.known()
        slots = [s if s in known else None for s in slots]
        for builtin in BUILTIN:  # built-in channels can never be lost
            if builtin not in slots:
                if None in slots:
                    slots[slots.index(None)] = builtin
                else:
                    slots.append(builtin)
        return slots

    def save_slots(self, slots):
        ids = [s for s in slots if s is not None]
        if (any(s not in self.known() for s in ids) or len(ids) != len(set(ids))
                or any(b not in ids for b in BUILTIN)):
            return False
        while slots and slots[-1] is None:
            slots = slots[:-1]
        self.layout_file.write_text(json.dumps({"slots": slots}))
        return True

    def layout(self):
        slots = self.slots()
        channels = {c["id"]: c for c in self.catalog()}
        channels.update(BUILTIN)
        return {"slots": slots, "channels": {s: channels[s] for s in slots if s}}

    def listing(self):
        """The shop's view of the catalog."""
        have = set(self.slots())
        return [{**c, "installed": c["id"] in have, "job": self.jobs.get(c["id"])} for c in self.catalog()]

    # ---------- getting and removing channels ----------

    def install(self, channel_id):
        channel = self.channel(channel_id)
        if channel is None or channel_id in self.slots() or self.jobs.get(channel_id) == "downloading":
            return False
        self.jobs[channel_id] = "downloading"
        threading.Thread(target=self._install, args=(channel,), daemon=True).start()
        return True

    def _install(self, channel):
        app = channel.get("flatpak")
        try:
            if app and not flatpak_present(app):
                # A native app: download it for this user (no admin rights needed).
                self.log(f"downloading {app}")
                run(["flatpak", "remote-add", "--user", "--if-not-exists", "flathub", FLATHUB])
                run(["flatpak", "install", "--user", "-y", "--noninteractive", "flathub", app])
            if app:
                for override in channel.get("flatpak_overrides", []):
                    run(["flatpak", "override", "--user", *override.split(), app])
        except subprocess.CalledProcessError as err:
            self.log(f"could not download {channel['id']}: {err.stderr or err}")
            self.jobs[channel["id"]] = "failed"
            return
        with self.lock:
            slots = self.slots()
            if None in slots:
                slots[slots.index(None)] = channel["id"]
            else:
                slots.append(channel["id"])
            self.save_slots(slots)
        self.jobs.pop(channel["id"], None)
        self.log(f"added channel {channel['id']}")
        self.messages.add(
            f"New channel: {channel['name']}",
            f"{channel['name']} was downloaded and added to your home menu.",
            kind="channel-added",
        )

    def remove(self, channel_id):
        channel = self.channel(channel_id)
        if channel is None or channel.get("builtin"):
            return False
        with self.lock:
            slots = [None if s == channel_id else s for s in self.slots()]
            self.save_slots(slots)
        app = channel.get("flatpak")
        if app:
            # Free the space too. Fails harmlessly if it was installed system-wide.
            threading.Thread(target=subprocess.run, args=(["flatpak", "uninstall", "--user", "-y", app],),
                             kwargs={"capture_output": True}, daemon=True).start()
        self.log(f"removed channel {channel_id}")
        return True


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def flatpak_present(app):
    return subprocess.run(["flatpak", "info", app], capture_output=True).returncode == 0

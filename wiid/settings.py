"""User settings, changed in the Settings channel and kept in settings.json."""
import json
import threading

SCREENSAVER_HOURS = [0, 1, 2, 3, 4, 6]  # 0 = never
DEFAULTS = {
    "screensaver_hours": 2,  # hours without input before the screen saver
    "suspend": True,  # Home pauses the channel instead of closing it
}


class Settings:
    def __init__(self, state_dir):
        self.file = state_dir / "settings.json"
        self.lock = threading.Lock()

    def all(self):
        try:
            saved = json.loads(self.file.read_text())
        except (OSError, ValueError):
            saved = {}
        return {k: saved.get(k, v) for k, v in DEFAULTS.items()}

    def get(self, key):
        return self.all()[key]

    def update(self, changes):
        with self.lock:
            values = self.all()
            if "screensaver_hours" in changes:
                if changes["screensaver_hours"] not in SCREENSAVER_HOURS:
                    return False
                values["screensaver_hours"] = changes["screensaver_hours"]
            if "suspend" in changes:
                values["suspend"] = bool(changes["suspend"])
            self.file.write_text(json.dumps(values))
        return True

    def describe(self):
        return {"values": self.all(), "screensaver_hours": SCREENSAVER_HOURS}

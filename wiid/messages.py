"""The message board behind the envelope button.

Messages are a permanent local record for the user (updates offered and
installed, channels added). They are never deleted; reading one only clears
its unread mark.
"""
import json
import threading
import time


class Messages:
    def __init__(self, state_dir):
        self.file = state_dir / "messages.json"
        self.lock = threading.Lock()

    def _load(self):
        try:
            return json.loads(self.file.read_text())
        except (OSError, ValueError):
            return []

    def _save(self, messages):
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(messages, indent=1))
        tmp.replace(self.file)

    def all(self):
        with self.lock:
            messages = self._load()
        return {"messages": messages[::-1], "unread": sum(not m["read"] for m in messages)}

    def add(self, title, body, kind="info", data=None):
        with self.lock:
            messages = self._load()
            messages.append({
                "id": int(time.time() * 1000),
                "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "title": title,
                "body": body,
                "kind": kind,
                "data": data or {},
                "read": False,
            })
            self._save(messages)

    def mark_read(self, message_id):
        with self.lock:
            messages = self._load()
            for m in messages:
                if m["id"] == message_id:
                    m["read"] = True
            self._save(messages)

    def has(self, kind, **data):
        with self.lock:
            return any(m["kind"] == kind and all(m["data"].get(k) == v for k, v in data.items())
                       for m in self._load())

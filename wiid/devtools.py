"""Injects a script into every page and frame of a Chrome channel.

Uses Chrome's DevTools protocol over --remote-debugging-pipe: Chrome reads
commands on fd 3 and writes replies and events on fd 4, as NUL-terminated
JSON. A pipe, unlike a debugging port, is reachable only by wiid.
"""
import json
import os
import subprocess
import threading


def launch_with_script(cmd, source, log):
    """Starts Chrome (cmd) and keeps `source` injected into all its pages."""
    to_chrome_r, to_chrome_w = os.pipe()
    from_chrome_r, from_chrome_w = os.pipe()

    def wire_pipes():  # in the child, before exec: put the pipe ends on fds 3 and 4
        os.dup2(to_chrome_r, 3)
        os.dup2(from_chrome_w, 4)

    proc = subprocess.Popen(
        [cmd[0], "--remote-debugging-pipe", *cmd[1:]],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=wire_pipes,
        # The dup2'd fds 3 and 4 must survive exec. Everything else Python
        # opens is close-on-exec already, so nothing else leaks into Chrome.
        close_fds=False,
    )
    os.close(to_chrome_r)
    os.close(from_chrome_w)
    session = _Injector(to_chrome_w, from_chrome_r, source, log)
    threading.Thread(target=session.run, daemon=True).start()
    return proc


class _Injector:
    def __init__(self, write_fd, read_fd, source, log):
        self.out = os.fdopen(write_fd, "wb", buffering=0)
        self.inp = os.fdopen(read_fd, "rb", buffering=0)
        self.source = source
        self.log = log
        self.next_id = 0
        self.attached = set()

    def send(self, method, params=None, session=None):
        self.next_id += 1
        msg = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        try:
            self.out.write(json.dumps(msg).encode() + b"\0")
        except OSError:
            pass  # Chrome has exited

    def run(self):
        # Hear about every page and iframe, existing ones included.
        self.send("Target.setDiscoverTargets", {"discover": True})
        buf = b""
        while True:
            try:
                chunk = self.inp.read(65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            buf += chunk
            while b"\0" in buf:
                raw, buf = buf.split(b"\0", 1)
                try:
                    self.handle(json.loads(raw))
                except (ValueError, KeyError) as err:
                    self.log(f"devtools: bad message: {err}")
        self.out.close()
        self.inp.close()

    def handle(self, msg):
        if "error" in msg:
            self.log(f"devtools: command {msg.get('id')} failed: {msg['error'].get('message')}")
            return
        method = msg.get("method")
        params = msg.get("params", {})
        if method == "Target.targetCreated":
            info = params["targetInfo"]
            if info["type"] in ("page", "iframe") and info["targetId"] not in self.attached:
                self.attached.add(info["targetId"])
                self.send("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})
        elif method == "Target.attachedToTarget":
            session = params["sessionId"]
            self.log(f"devtools: injecting into {params['targetInfo']['type']} {params['targetInfo']['url'][:60]}")
            # Without Page.enable, the script reaches only the current document,
            # not the ones the tab navigates to afterwards.
            self.send("Page.enable", {}, session)
            self.send("Page.addScriptToEvaluateOnNewDocument", {
                "source": self.source,
                "worldName": "wii-os",  # isolated from the site's own scripts
                "runImmediately": True,
            }, session)
            self.send("Runtime.runIfWaitingForDebugger", {}, session)
        elif method == "Target.targetDestroyed":
            self.attached.discard(params["targetId"])

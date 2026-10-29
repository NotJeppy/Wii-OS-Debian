"""Injects scripts into every page and frame of a Chrome channel.

Uses Chrome's DevTools protocol over --remote-debugging-pipe: Chrome reads
commands on fd 3 and writes replies and events on fd 4, as NUL-terminated
JSON. A pipe, unlike a debugging port, is reachable only by wiid.

The scripts can talk back: each page's isolated world gets a function
__wiiNotify(json) whose calls arrive here and go to `on_message`, and wiid can
call functions the scripts define with `proc.devtools.call(...)`.
"""
import json
import os
import subprocess
import threading


WORLD = "wii-os"  # the isolated world our scripts run in, apart from the site's


def launch_with_scripts(cmd, sources, log, on_message=None):
    """Starts Chrome (cmd) and keeps `sources` injected, in order, into all its pages."""
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
    session = _Injector(to_chrome_w, from_chrome_r, sources, log, on_message)
    threading.Thread(target=session.run, daemon=True).start()
    proc.devtools = session
    return proc


class _Injector:
    def __init__(self, write_fd, read_fd, sources, log, on_message):
        self.out = os.fdopen(write_fd, "wb", buffering=0)
        self.inp = os.fdopen(read_fd, "rb", buffering=0)
        self.sources = sources
        self.log = log
        self.on_message = on_message
        self.next_id = 0
        self.attached = set()
        self.pages = {}  # session -> its page's target id (the main frame's id too)
        self.worlds = {}  # session -> our isolated world in that page's main frame
        self.lock = threading.Lock()  # wiid's threads send too, through call()

    def send(self, method, params=None, session=None):
        with self.lock:
            self.next_id += 1
            msg = {"id": self.next_id, "method": method, "params": params or {}}
            if session:
                msg["sessionId"] = session
            try:
                self.out.write(json.dumps(msg).encode() + b"\0")
            except (OSError, ValueError):
                pass  # Chrome has exited

    def call(self, function, *args):
        """Calls window.<function>(*args) in our world of every top-level page."""
        expression = f"window.{function} && window.{function}(...{json.dumps(args)})"
        for session, context in list(self.worlds.items()):
            self.send("Runtime.evaluate", {"expression": expression, "contextId": context}, session)

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
            if params["targetInfo"]["type"] == "page":
                self.pages[session] = params["targetInfo"]["targetId"]
            self.log(f"devtools: injecting into {params['targetInfo']['type']} {params['targetInfo']['url'][:60]}")
            # Without Page.enable, the script reaches only the current document,
            # not the ones the tab navigates to afterwards.
            self.send("Page.enable", {}, session)
            self.send("Runtime.enable", {}, session)
            # Installed in our isolated world only; the site can't call it.
            self.send("Runtime.addBinding", {"name": "__wiiNotify", "executionContextName": WORLD}, session)
            for source in self.sources:
                self.send("Page.addScriptToEvaluateOnNewDocument", {
                    "source": source,
                    "worldName": WORLD,
                    "runImmediately": True,
                }, session)
            self.send("Runtime.runIfWaitingForDebugger", {}, session)
        elif method == "Runtime.executionContextCreated":
            context = params["context"]
            frame = (context.get("auxData") or {}).get("frameId")
            if context.get("name") == WORLD and frame and frame == self.pages.get(msg.get("sessionId")):
                self.worlds[msg["sessionId"]] = context["id"]
        elif method == "Target.detachedFromTarget":
            self.pages.pop(params.get("sessionId"), None)
            self.worlds.pop(params.get("sessionId"), None)
        elif method == "Runtime.bindingCalled":
            if params.get("name") == "__wiiNotify" and self.on_message:
                try:
                    self.on_message(json.loads(params["payload"]))
                except ValueError:
                    pass
        elif method == "Target.targetInfoChanged":
            info = params["targetInfo"]
            if info["type"] == "page":
                self.log(f"devtools: page is now {info['url'][:100]}")
        elif method == "Target.targetDestroyed":
            self.attached.discard(params["targetId"])

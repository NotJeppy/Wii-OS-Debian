// The message board behind the envelope button: a permanent record of
// updates and new channels. Messages are never deleted; reading one clears
// its unread mark, and the envelope shows a red dot while any are unread.
import { play } from "./sounds.js";
import { $, api, make, setMode, updateFocus, views } from "./core.js";

const VISIBLE = 6;

let list = [];
let index = 0;
let callbacks = null;
let actions = [];
let actionIndex = 0;

export async function refreshBadge() {
  const data = await api("/api/messages").catch(() => null);
  $("mail-badge").hidden = !data?.unread;
}

export async function openMessages(cb) {
  callbacks = cb;
  list = (await api("/api/messages").catch(() => null))?.messages ?? [];
  index = 0;
  $("messages").hidden = false;
  $("menu").classList.add("dim");
  play("open");
  showList();
}

function when(message) {
  const d = new Date(message.time);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function showList() {
  $("msg-detail").hidden = true;
  $("msg-list").hidden = false;
  if (!list.length) {
    $("msg-list").replaceChildren(make("div", "msg-empty", "No messages yet."));
  } else {
    const start = Math.max(0, Math.min(index - 2, list.length - VISIBLE));
    $("msg-list").replaceChildren(...list.slice(start, start + VISIBLE).map((m, i) => {
      const row = make("div", m.read ? "msg-row" : "msg-row unread");
      row.dataset.i = start + i;
      row.dataset.hand = "0.7,0.3"; // between the title and the date
      row.append(make("span", "msg-dot"), make("span", "msg-title", m.title), make("span", "msg-date", when(m)));
      return row;
    }));
  }
  setMode("messages");
}

function close(quiet = false) {
  $("messages").hidden = true;
  $("menu").classList.remove("dim");
  if (!quiet) play("back");
  callbacks.onClose();
}

async function openMessage(message) {
  play("select");
  if (!message.read) {
    message.read = true;
    api("/api/messages/read", { id: message.id }).catch(() => null);
  }
  $("msg-list").hidden = true;
  $("msg-detail").hidden = false;
  $("msg-d-title").textContent = message.title;
  $("msg-d-date").textContent = when(message);
  $("msg-d-body").textContent = message.body;
  setActions([{ label: "Back", run: showListQuietly }]);
  setMode("message");

  if (message.kind === "update-available") {
    // Offer the update again, as long as it is still the one to install.
    const s = await api("/api/update?all=1").catch(() => null);
    if (s?.available?.version === message.data.version) {
      setActions([
        { label: "Update now", run: () => { close(true); callbacks.installUpdate(s.available); } },
        { label: "Back", run: showListQuietly },
      ]);
      updateFocus();
    }
  }
}

function showListQuietly() {
  play("back");
  showList();
}

function setActions(next) {
  actions = next;
  actionIndex = 0;
  $("msg-d-actions").replaceChildren(...actions.map((a) => make("div", "pill", a.label)));
}

views.messages = {
  focused: () => $("msg-list").querySelector(`[data-i="${index}"]`),
  key(k) {
    if (k.dir && k.dir[1]) {
      const next = index + k.dir[1];
      if (next < 0 || next >= list.length) return play("bump");
      index = next;
      play("move");
      showList();
    } else if (k.ok && list[index]) {
      openMessage(list[index]);
    } else if (k.back) {
      close();
    }
  },
};

views.message = {
  focused: () => $("msg-d-actions").children[actionIndex],
  key(k) {
    const step = k.dir ? k.dir[0] || k.dir[1] : 0;
    if (step) {
      const next = actionIndex + step;
      if (next < 0 || next >= actions.length) return play("bump");
      actionIndex = next;
      play("move");
      updateFocus();
    } else if (k.ok) {
      actions[actionIndex].run();
    } else if (k.back) {
      showListQuietly();
    }
  },
};

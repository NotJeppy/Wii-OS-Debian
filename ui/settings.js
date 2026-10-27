// The Settings channel. Built in, so it runs inside the menu page like the
// shop. Up/Down pick a row, Left/Right (or A) change it; changes save at once.
import { play } from "./sounds.js";
import { $, api, make, setMode, updateFocus, views } from "./core.js";

let rows = [];
let index = 0;
let values = {};
let hourChoices = [];
let callbacks = null;
let homeTimer = null;

function hoursLabel(h) {
  if (!h) return "Never";
  return h === 1 ? "After 1 hour" : `After ${h} hours`;
}

function buildRows() {
  return [
    {
      title: "Screen saver",
      text: "After this long without a button press, a slowly moving screen protects your TV from burn-in. Watching something counts as activity.",
      value: () => hoursLabel(values.screensaver_hours),
      change(step) {
        const i = hourChoices.indexOf(values.screensaver_hours);
        const next = hourChoices[i + step];
        if (next === undefined) return false;
        values.screensaver_hours = next;
        save({ screensaver_hours: next });
        return true;
      },
    },
    {
      title: "Suspend channels",
      text: "Home pauses the channel, so you can pick up where you left off. A paused channel closes after 30 minutes, or when you open a different one.",
      value: () => (values.suspend ? "On" : "Off"),
      change() {
        values.suspend = !values.suspend;
        save({ suspend: values.suspend });
        return true;
      },
      toggle: true,
    },
    {
      title: "Try the screen saver",
      text: "Press any button to come back.",
      value: () => "",
      run() {
        play("select");
        api("/api/screensaver", {}).catch(() => null);
      },
    },
  ];
}

function save(changes) {
  api("/api/settings", changes).catch(() => null);
}

function render() {
  $("settings-list").replaceChildren(...rows.map((row) => {
    const el = make("div", "set-row");
    el.dataset.hand = "0.97,0.7"; // the corner, clear of the value
    const words = make("div", "set-words");
    words.append(make("div", "set-title", row.title), make("div", "set-text", row.text));
    el.append(words);
    if (row.change) {
      const value = make("div", "set-value");
      value.append(make("span", "set-arrow", "◀"), make("span", "set-current", row.value()), make("span", "set-arrow", "▶"));
      el.append(value);
    }
    return el;
  }));
  updateFocus();
}

export async function openSettings(cb) {
  callbacks = cb;
  const data = await api("/api/settings").catch(() => null);
  values = data?.values ?? { screensaver_hours: 2, suspend: true };
  hourChoices = data?.screensaver_hours ?? [0, 1, 2, 3, 4, 6];
  rows = buildRows();
  index = 0;
  $("settings").hidden = false;
  setMode("settings");
  render();
  // Home closes channels in wiid; Settings lives in this page, so watch for it.
  const start = (await api("/api/state").catch(() => ({}))).home_presses;
  homeTimer = setInterval(async () => {
    const s = await api("/api/state").catch(() => null);
    if (s && s.home_presses !== start) close();
  }, 600);
}

function close() {
  clearInterval(homeTimer);
  $("settings").hidden = true;
  play("back");
  callbacks.onClose();
}

views.settings = {
  focused: () => $("settings-list").children[index] ?? null,
  key(k) {
    const row = rows[index];
    if (k.dir && k.dir[1]) {
      const next = index + k.dir[1];
      if (next < 0 || next >= rows.length) return play("bump");
      index = next;
      play("move");
      updateFocus();
    } else if (k.dir && k.dir[0] && row.change) {
      play(row.change(k.dir[0]) ? "move" : "bump");
      render();
    } else if (k.ok) {
      if (row.run) row.run();
      else if (row.toggle) {
        row.change();
        play("select");
        render();
      } else play("bump");
    } else if (k.back) {
      close();
    }
  },
};

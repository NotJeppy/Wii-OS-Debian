// The Settings channel. Built in, so it runs inside the menu page like the
// shop. Up/Down pick a row, Left/Right (or A) change it; changes save at once.
// Wi-Fi and Bluetooth open pages of their own, which refresh while they're
// open. Wi-Fi passwords are typed on the on-screen keyboard (osk.js).
import { play } from "./sounds.js";
import { $, api, make, setMode, state, updateFocus, views } from "./core.js";

let page = "main"; // main | wifi | bluetooth
let rows = [];
let index = 0;
let values = {};
let hourChoices = [];
let wifi = { available: false };
let bt = { available: false };
let callbacks = null;
let homeTimer = null;
let pageTimer = null;
let scanTimer = null;
let forgetArmed = null; // the row key that Y was pressed on once
let wifiError = {}; // ssid -> message from the last try
let dialog = null; // { ssid, index } while the Wi-Fi password box is open
let touched = false; // a key was pressed since Settings opened

function hoursLabel(h) {
  if (!h) return "Never";
  return h === 1 ? "After 1 hour" : `After ${h} hours`;
}

// ---------- the main page ----------

function wifiSummary() {
  if (!wifi.on) return "Off";
  return wifi.current ?? (wifi.wired ? "Cable" : "Not connected");
}

function btSummary() {
  if (!bt.on) return "Off";
  const n = bt.devices.filter((d) => d.connected).length;
  return n ? `${n} connected` : "On";
}

function mainRows() {
  const list = [];
  if (wifi.available) {
    list.push({
      key: "wifi",
      title: "Wi-Fi",
      text: wifi.current
        ? `Connected to ${wifi.current}. Choose another network, or see what's nearby.`
        : wifi.wired
          ? "Online through a cable. You can also choose a Wi-Fi network."
          : "Not connected. Choose a network to get online.",
      value: wifiSummary,
      open: () => { play("select"); openPage("wifi"); },
    });
  }
  if (bt.available) {
    list.push({
      key: "bluetooth",
      title: "Bluetooth",
      text: "Pair wireless controllers, keyboards and headphones.",
      value: btSummary,
      open: () => { play("select"); openPage("bluetooth"); },
    });
  }
  list.push(
    {
      key: "screensaver",
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
      key: "suspend",
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
      key: "try",
      title: "Try the screen saver",
      text: "Press any button to come back.",
      run() {
        play("select");
        api("/api/screensaver", {}).catch(() => null);
      },
    },
  );
  return list;
}

// ---------- Wi-Fi ----------

function bars(signal) {
  const box = make("span", "bars");
  const lit = signal > 75 ? 4 : signal > 50 ? 3 : signal > 25 ? 2 : 1;
  for (let i = 1; i <= 4; i++) box.append(make("i", i <= lit ? "lit" : ""));
  return box;
}

function wifiRows() {
  const list = [{
    key: "wifi-on",
    title: "Wi-Fi",
    text: !wifi.on
      ? "Wi-Fi is off."
      : wifi.current
        ? `Connected to ${wifi.current}.`
        : wifi.wired ? "Online through a cable." : "Not connected. Choose a network below.",
    value: () => (wifi.on ? "On" : "Off"),
    change() {
      wifi.on = !wifi.on;
      api("/api/wifi/on", { on: wifi.on }).catch(() => null).then(refresh);
      return true;
    },
    toggle: true,
  }];
  if (!wifi.on) return list;
  for (const net of wifi.networks) {
    const armed = forgetArmed === `net:${net.ssid}`;
    let text;
    if (wifi.connecting === net.ssid) text = "Connecting…";
    else if (armed) text = "Press Y again to forget this network, or move away to keep it.";
    else if (net.connected) text = net.saved ? "Connected. Press Y to forget it." : "Connected.";
    else if (wifiError[net.ssid]) text = wifiError[net.ssid];
    else if (net.enterprise) text = "Needs a work or school sign-in, which Wii-OS can't do yet.";
    else if (net.saved) text = "Saved. Press A to connect, Y to forget it.";
    else text = net.secure ? "Needs a password." : "Open network: anyone nearby can see what you do on it.";
    list.push({
      key: `net:${net.ssid}`,
      title: net.ssid,
      text,
      compact: true,
      extra: () => [net.secure ? make("span", "lock", "🔒") : "", bars(net.signal)],
      run() {
        if (net.connected || net.enterprise || wifi.connecting) return play("bump");
        play("select");
        if (net.secure && !net.saved) openDialog(net.ssid);
        else joinWifi(net.ssid);
      },
      forget: net.saved
        ? () => api("/api/wifi/forget", { ssid: net.ssid }).catch(() => null).then(refresh)
        : null,
    });
  }
  if (!wifi.networks.length) {
    list.push({ key: "none", title: "Looking for networks…", text: "Networks nearby show up here.", compact: true });
  }
  return list;
}

async function joinWifi(ssid, password) {
  delete wifiError[ssid];
  wifi.connecting = ssid;
  render();
  const res = await api("/api/wifi/connect", { ssid, password }).catch(() => ({ ok: false }));
  if (res.ok) play("select");
  else {
    wifiError[ssid] = `${res.error ?? "Couldn't connect."} Press A to try again.`;
    play("bump");
  }
  await refresh();
}

// The password box: the field (A opens the on-screen keyboard, whose Enter
// connects) and a Connect button below it.
function openDialog(ssid) {
  dialog = { ssid, index: 0 };
  $("set-dialog-title").textContent = `Password for ${ssid}`;
  $("set-password").value = "";
  $("set-dialog-note").textContent = "Press A to type with the on-screen keyboard. Its Enter key connects.";
  $("set-dialog").hidden = false;
  $("set-password").focus(); // so A opens the keyboard straight away
  updateFocus();
}

function closeDialog() {
  dialog = null;
  $("set-password").blur();
  $("set-dialog").hidden = true;
  updateFocus();
}

$("set-dialog-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!dialog) return;
  const password = $("set-password").value;
  if (password.length < 8) {
    play("bump");
    $("set-dialog-note").textContent = "Wi-Fi passwords are at least 8 characters.";
    return;
  }
  const { ssid } = dialog;
  closeDialog();
  joinWifi(ssid, password);
});

// While the keyboard is up, the menu's pointing hand would cover it.
addEventListener("wii-osk-open", () => $("hand").classList.add("hidden"));
addEventListener("wii-osk-close", () => updateFocus());

// ---------- Bluetooth ----------

function btRows() {
  const list = [{
    key: "bt-on",
    title: "Bluetooth",
    text: bt.on
      ? "Put a controller or other device in pairing mode, and it shows up below. Press A on it to pair."
      : "Bluetooth is off.",
    value: () => (bt.on ? "On" : "Off"),
    change() {
      bt.on = !bt.on;
      api("/api/bluetooth/on", { on: bt.on }).catch(() => null).then(() => {
        if (bt.on) api("/api/bluetooth/scan", {}).catch(() => null);
        setTimeout(refresh, 800);
      });
      return true;
    },
    toggle: true,
  }];
  if (!bt.on) return list;
  for (const d of bt.devices) {
    const armed = forgetArmed === `bt:${d.address}`;
    const kind = d.kind || "Device";
    let text;
    if (bt.code && bt.code.address === d.address) text = `Type ${bt.code.code} on the keyboard, then press Enter.`;
    else if (d.busy) text = { pairing: "Pairing…", connecting: "Connecting…", disconnecting: "Disconnecting…" }[d.busy];
    else if (armed) text = "Press Y again to forget it. To use it again, you'd pair it again.";
    else if (d.error) text = d.error;
    else if (d.connected) text = `${kind}. Connected. A disconnects, Y forgets it.`;
    else if (d.paired) text = `${kind}. Paired. A connects, Y forgets it.`;
    else text = `${d.kind || "New device"}. Press A to pair.`;
    const action = d.paired ? (d.connected ? "disconnect" : "connect") : "pair";
    list.push({
      key: `bt:${d.address}`,
      title: d.name,
      text,
      compact: true,
      extra: () => [make("span", `bt-state${d.connected ? " on" : ""}`, d.connected ? "Connected" : d.paired ? "Paired" : "")],
      run() {
        if (d.busy) return play("bump");
        play("select");
        d.busy = action === "pair" ? "pairing" : `${action}ing`;
        render();
        api(`/api/bluetooth/${action}`, { address: d.address }).catch(() => null).then(refresh);
      },
      forget: d.paired
        ? () => api("/api/bluetooth/forget", { address: d.address }).catch(() => null).then(() => setTimeout(refresh, 600))
        : null,
    });
  }
  if (!bt.devices.length) {
    list.push({ key: "none", title: "Looking for devices…", text: "Devices in pairing mode show up here.", compact: true });
  }
  return list;
}

// ---------- pages ----------

async function loadNetwork() {
  const [w, b] = await Promise.all([
    api("/api/wifi").catch(() => null),
    api("/api/bluetooth").catch(() => null),
  ]);
  wifi = w ?? { available: false };
  bt = b ?? { available: false };
}

async function refresh() {
  if (page === "wifi") wifi = (await api("/api/wifi").catch(() => null)) ?? wifi;
  else if (page === "bluetooth") bt = (await api("/api/bluetooth").catch(() => null)) ?? bt;
  if (!dialog) render();
}

function buildRows() {
  return page === "wifi" ? wifiRows() : page === "bluetooth" ? btRows() : mainRows();
}

function stopTimers() {
  clearInterval(pageTimer);
  clearInterval(scanTimer);
  pageTimer = scanTimer = null;
}

function openPage(name, focusKey = null) {
  stopTimers();
  page = name;
  rows = [];
  index = 0;
  forgetArmed = null;
  wifiError = {};
  $("settings-title").textContent = { wifi: "Wi-Fi", bluetooth: "Bluetooth", main: "Settings" }[name];
  $("settings-hint").textContent = name === "main" ? "Back to the menu" : "Back to Settings";
  if (name === "wifi") {
    const scan = () => api("/api/wifi/scan", {}).catch(() => null);
    scan();
    scanTimer = setInterval(scan, 15000);
    pageTimer = setInterval(refresh, 3000);
  } else if (name === "bluetooth") {
    // Discovery stops by itself unless this page keeps asking.
    const scan = () => bt.on && api("/api/bluetooth/scan", {}).catch(() => null);
    scan();
    scanTimer = setInterval(scan, 20000);
    pageTimer = setInterval(refresh, 1500);
  }
  if (focusKey) rows = [{ key: focusKey }]; // render() keeps focus on that row
  render();
  if (name !== "main") refresh();
}

async function backToMain() {
  stopTimers();
  play("back");
  const from = page;
  await loadNetwork(); // the summaries may have changed
  openPage("main", from);
}

function render() {
  const focusedKey = rows[index]?.key;
  rows = buildRows();
  const kept = rows.findIndex((r) => r.key === focusedKey);
  if (kept >= 0) index = kept;
  index = Math.min(index, rows.length - 1);
  $("settings-list").replaceChildren(...rows.map((row) => {
    const el = make("div", row.compact ? "set-row compact" : "set-row");
    // Clear of the text and the value (signal bars, on the right of a network).
    el.dataset.hand = row.extra ? "0.8,0.6" : "0.97,0.7";
    const words = make("div", "set-words");
    words.append(make("div", "set-title", row.title), make("div", "set-text", row.text));
    el.append(words);
    if (row.change) {
      const value = make("div", "set-value");
      value.append(make("span", "set-arrow", "◀"), make("span", "set-current", row.value()), make("span", "set-arrow", "▶"));
      el.append(value);
    } else if (row.open) {
      const value = make("div", "set-value");
      value.append(make("span", "set-current", row.value()), make("span", "set-chevron", "›"));
      el.append(value);
    } else if (row.extra) {
      const value = make("div", "set-value");
      value.append(...row.extra());
      el.append(value);
    }
    return el;
  }));
  $("settings-list").children[index]?.scrollIntoView({ block: "nearest" });
  updateFocus();
}

function save(changes) {
  api("/api/settings", changes).catch(() => null);
}

export async function openSettings(cb) {
  callbacks = cb;
  touched = false;
  const data = await api("/api/settings").catch(() => null);
  values = data?.values ?? { screensaver_hours: 2, suspend: true };
  hourChoices = data?.screensaver_hours ?? [0, 1, 2, 3, 4, 6];
  $("settings").hidden = false;
  setMode("settings");
  openPage("main");
  // Wi-Fi and Bluetooth can be slow to answer: open without them, and add
  // their rows (or refresh last time's) once they do.
  loadNetwork().then(() => {
    if (state.mode !== "settings" || page !== "main" || $("settings").hidden) return;
    if (!touched) {
      rows = []; // nobody has moved yet: start on the top row, now Wi-Fi
      index = 0;
    }
    render();
  });
  // Home closes channels in wiid; Settings lives in this page, so watch for it.
  const start = (await api("/api/state").catch(() => ({}))).home_presses;
  homeTimer = setInterval(async () => {
    const s = await api("/api/state").catch(() => null);
    if (s && s.home_presses !== start) close();
  }, 600);
}

function close() {
  clearInterval(homeTimer);
  stopTimers();
  if (dialog) closeDialog();
  $("settings").hidden = true;
  play("back");
  callbacks.onClose();
}

function dialogKey(k) {
  if (k.dir && k.dir[1]) {
    const next = dialog.index + k.dir[1];
    if (next < 0 || next > 1) return play("bump");
    dialog.index = next;
    if (next === 0) $("set-password").focus();
    else $("set-password").blur();
    play("move");
    updateFocus();
  } else if (k.ok) {
    // On the field, Enter opens the on-screen keyboard (osk.js sees it first
    // and keeps it from us). We only get it from a real keyboard: connect.
    if (dialog.index === 1 || $("set-password").value) $("set-dialog-form").requestSubmit();
    else $("set-password").focus();
  } else if (k.back) {
    play("back");
    closeDialog();
  }
}

views.settings = {
  focused() {
    if (dialog) return dialog.index === 0 ? $("set-password-box") : $("set-connect");
    return $("settings-list").children[index] ?? null;
  },
  key(k) {
    touched = true;
    if (dialog) return dialogKey(k);
    const row = rows[index];
    if (k.dir && k.dir[1]) {
      const next = index + k.dir[1];
      if (next < 0 || next >= rows.length) return play("bump");
      index = next;
      forgetArmed = null;
      play("move");
      render();
    } else if (k.dir && k.dir[0] && row.change) {
      play(row.change(k.dir[0]) ? "move" : "bump");
      render();
    } else if (k.ok) {
      if (row.open) row.open();
      else if (row.run) row.run();
      else if (row.toggle) {
        row.change();
        play("select");
        render();
      } else play("bump");
    } else if (k.y && row?.forget) {
      if (forgetArmed === row.key) {
        forgetArmed = null;
        play("back");
        row.forget();
      } else {
        forgetArmed = row.key;
        play("move");
      }
      render();
    } else if (k.back) {
      if (page === "main") close();
      else backToMain();
    }
  },
};

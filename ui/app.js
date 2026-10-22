// The channel menu. wiid turns the controller into arrow keys, Enter (A),
// Escape (B) and PageUp/PageDown (bumpers), so this only handles keys.
import { play } from "./sounds.js";
import { startClock } from "./clock.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const PER_PAGE = 12;
const COLS = 4;

let channels = [];
let page = 0;
let mode = "welcome"; // welcome | menu | preview | panel | running
let focus = { area: "grid", index: 0 }; // area: grid | buttons
let previewChannel = null;
let previewFocus = 1; // 0 = Menu, 1 = Start
let panel = null; // { actions, index, armed }

// ---------- helpers ----------

function scale() {
  return Math.min(innerWidth / 1920, innerHeight / 1080);
}

function fit() {
  document.documentElement.style.setProperty("--scale", scale());
  placeHand();
}

function rectInStage(el) {
  const s = scale();
  const st = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: (r.left - st.left) / s, y: (r.top - st.top) / s, w: r.width / s, h: r.height / s };
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, options);
  return res.json();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function span(className, text = "") {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

// Hand-drawn banners for known channels: [logo mark class, wordmark].
const BANNERS = {
  youtube: ["yt-logo", "YouTube"],
  twitch: ["tw-logo", "twitch"],
  plex: ["px-logo", "plex"],
  netflix: ["", "NETFLIX"],
  disney: ["", "Disney+"],
  hulu: ["", "hulu"],
};

function banner(channel) {
  const div = document.createElement("div");
  div.className = "banner";
  const known = BANNERS[channel.banner];
  if (known) {
    div.classList.add(`banner-${channel.banner}`);
    div.append(span(known[0]), span("wordmark", known[1]));
  } else {
    div.classList.add("banner-generic");
    div.style.background = channel.color || "linear-gradient(#5ab9ea, #2b7fc0)";
    div.textContent = channel.name;
  }
  return div;
}

// ---------- focus + hand ----------

function focusedEl() {
  if (mode === "preview") return [$("pv-menu"), $("pv-start")][previewFocus];
  if (mode === "panel") return $("panel-actions").children[panel.index];
  if (focus.area === "grid") return $("grid").children[focus.index];
  return [$("btn-system"), $("btn-mail")][focus.index];
}

function updateFocus() {
  document.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
  focusedEl()?.classList.add("focused");
  placeHand();
}

function placeHand() {
  const hand = $("hand");
  const el = focusedEl();
  if (!el || mode === "welcome" || mode === "running") {
    hand.classList.add("hidden");
    return;
  }
  hand.classList.remove("hidden");
  const r = rectInStage(el);
  const low = el.classList.contains("round-btn") ? 0.3 : 0.55;
  hand.style.transform = `translate(${r.x + r.w * 0.62 - 46}px, ${r.y + r.h * low}px)`;
}

// ---------- grid ----------

function pageCount() {
  return Math.max(1, Math.ceil(channels.length / PER_PAGE));
}

function renderGrid() {
  const tiles = [];
  for (let i = 0; i < PER_PAGE; i++) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const channel = channels[page * PER_PAGE + i];
    if (channel) tile.append(banner(channel));
    tiles.push(tile);
  }
  $("grid").replaceChildren(...tiles);
  $("arrow-prev").hidden = page === 0;
  $("arrow-next").hidden = page >= pageCount() - 1;
  updateFocus();
}

function turnPage(delta, col) {
  const next = page + delta;
  if (next < 0 || next >= pageCount()) return false;
  page = next;
  if (focus.area === "grid" && col !== undefined) {
    const row = Math.floor(focus.index / COLS);
    focus.index = row * COLS + col;
  }
  renderGrid();
  return true;
}

function moveMenu(dx, dy) {
  if (focus.area === "grid") {
    const col = focus.index % COLS;
    const row = Math.floor(focus.index / COLS);
    if (dx) {
      if (col + dx < 0 || col + dx >= COLS) {
        if (!turnPage(dx, dx > 0 ? 0 : COLS - 1)) return play("bump");
        return play("move");
      }
      focus.index += dx;
    } else if (row + dy < 0) {
      return play("bump");
    } else if (row + dy >= PER_PAGE / COLS) {
      focus = { area: "buttons", index: col < COLS / 2 ? 0 : 1 };
    } else {
      focus.index += dy * COLS;
    }
  } else if (dy < 0) {
    focus = { area: "grid", index: PER_PAGE - COLS + (focus.index === 0 ? 0 : COLS - 1) };
  } else if (dx && focus.index + dx >= 0 && focus.index + dx <= 1) {
    focus.index += dx;
  } else {
    return play("bump");
  }
  play("move");
  updateFocus();
}

function chooseInMenu() {
  if (focus.area === "buttons") {
    return focus.index === 0 ? openSystemPanel() : openMessagesPanel();
  }
  const channel = channels[page * PER_PAGE + focus.index];
  if (!channel) return play("bump");
  openPreview(channel, $("grid").children[focus.index]);
}

// ---------- channel preview ----------

function tileTransform(el) {
  const r = rectInStage(el);
  return `translate(${r.x}px, ${r.y}px) scale(${r.w / 1920}, ${r.h / 1080})`;
}

function openPreview(channel, tile) {
  previewChannel = channel;
  previewFocus = 1;
  mode = "preview";
  $("preview-banner").replaceChildren(banner(channel));
  const preview = $("preview");
  preview.hidden = false;
  $("hand").classList.add("hidden");
  const anim = preview.animate(
    [{ transform: tileTransform(tile), opacity: 0.6 }, { transform: "none", opacity: 1 }],
    { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  $("menu").classList.add("dim");
  play("open");
  document.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
  anim.onfinish = () => mode === "preview" && updateFocus();
}

function closePreview() {
  mode = "menu";
  const preview = $("preview");
  const tile = $("grid").children[focus.index];
  $("menu").classList.remove("dim");
  play("close");
  const anim = preview.animate(
    [{ transform: "none", opacity: 1 }, { transform: tileTransform(tile), opacity: 0.4 }],
    { duration: 320, easing: "cubic-bezier(.5,0,.8,.5)" },
  );
  anim.onfinish = () => {
    preview.hidden = true;
    updateFocus();
  };
}

async function startChannel() {
  mode = "running";
  play("start");
  updateFocus();
  $("flash").classList.add("on");
  await wait(700);
  const res = await api("/api/launch", { id: previewChannel.id }).catch(() => null);
  if (!res?.ok) {
    $("flash").classList.remove("on");
    mode = "preview";
    play("bump");
    updateFocus();
    return;
  }
  waitForReturn();
}

// The channel runs in its own window on top of this one. Home (handled by
// wiid) or the channel exiting brings us back.
function waitForReturn() {
  const timer = setInterval(async () => {
    const state = await api("/api/state").catch(() => null);
    if (state && state.running === null) {
      clearInterval(timer);
      $("flash").classList.remove("on");
      closePreview();
    }
  }, 800);
}

// ---------- panels ----------

function openPanel(title, lines, actions) {
  mode = "panel";
  panel = { actions, index: 0, armed: null };
  $("panel-title").textContent = title;
  $("panel-body").replaceChildren(...lines.map(([label, value]) => {
    const row = document.createElement("div");
    if (label) {
      const b = document.createElement("b");
      b.textContent = value;
      row.append(`${label}: `, b);
    } else {
      row.textContent = value;
    }
    return row;
  }));
  $("panel-actions").replaceChildren(...actions.map((a) => {
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = a.label;
    return pill;
  }));
  $("panel").hidden = false;
  $("menu").classList.add("dim");
  play("open");
  updateFocus();
}

function closePanel() {
  $("panel").hidden = true;
  $("menu").classList.remove("dim");
  mode = "menu";
  play("back");
  updateFocus();
}

function disarm() {
  if (panel.armed === null) return;
  $("panel-actions").children[panel.armed].textContent = panel.actions[panel.armed].label;
  panel.armed = null;
}

function choosePanel() {
  const action = panel.actions[panel.index];
  if (action.confirm && panel.armed !== panel.index) {
    disarm();
    panel.armed = panel.index;
    $("panel-actions").children[panel.index].textContent = "Press A again";
    return play("select");
  }
  play("select");
  action.run();
}

async function power(action) {
  $("flash").classList.add("on");
  await api("/api/power", { action }).catch(() => null);
}

async function openSystemPanel() {
  const info = await api("/api/system").catch(() => ({}));
  openPanel("wii-os", [["Name", info.hostname ?? "unknown"], ["Address", info.ip ?? "not connected"]], [
    { label: "Back", run: closePanel },
    { label: "Restart menu", run: () => power("restart-menu") },
    { label: "Restart", run: () => power("reboot"), confirm: true },
    { label: "Power off", run: () => power("poweroff"), confirm: true },
  ]);
}

function openMessagesPanel() {
  openPanel("Messages", [["", "No new messages."]], [{ label: "Back", run: closePanel }]);
}

// ---------- input ----------

const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

addEventListener("keydown", (ev) => {
  ev.preventDefault();
  const dir = DIRS[ev.key];
  const ok = ev.key === "Enter" || ev.key === " ";
  const back = ev.key === "Escape" || ev.key === "Backspace";
  if ((ok || back) && ev.repeat) return;

  switch (mode) {
    case "welcome":
      if (ok) {
        mode = "menu";
        $("welcome").classList.add("gone");
        play("welcome");
        updateFocus();
      }
      break;

    case "menu":
      if (dir) moveMenu(...dir);
      else if (ok) chooseInMenu();
      else if (ev.key === "PageUp" || ev.key === "PageDown") {
        const col = focus.area === "grid" ? focus.index % COLS : undefined;
        play(turnPage(ev.key === "PageUp" ? -1 : 1, col) ? "move" : "bump");
      }
      break;

    case "preview":
      if (dir && dir[0]) {
        const next = previewFocus + dir[0];
        if (next < 0 || next > 1) return play("bump");
        previewFocus = next;
        play("move");
        updateFocus();
      } else if (ok) {
        if (previewFocus === 0) closePreview();
        else startChannel();
      } else if (back) {
        closePreview();
      }
      break;

    case "panel":
      if (dir && dir[1]) {
        const next = panel.index + dir[1];
        if (next < 0 || next >= panel.actions.length) return play("bump");
        disarm();
        panel.index = next;
        play("move");
        updateFocus();
      } else if (ok) {
        choosePanel();
      } else if (back) {
        closePanel();
      }
      break;
  }
});

// ---------- start ----------

fit();
addEventListener("resize", fit);
startClock($("clock"), $("date"));
channels = await api("/api/channels").catch(() => []);
renderGrid();

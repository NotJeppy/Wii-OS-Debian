// The home menu: the channel grid (with move mode and channel options),
// channel previews, the OS panel, and update offers.
import { play } from "./sounds.js";
import { startClock } from "./clock.js";
import { banner } from "./banners.js";
import { openShop } from "./shop.js";
import { openMessages, refreshBadge } from "./messages.js";
import {
  $, api, keyOf, make, placeHand, rectInStage, scale, setMode, state, updateFocus, views, wait,
} from "./core.js";

const PER_PAGE = 12;
const COLS = 4;
const ROWS = 3;

let slots = []; // channel id or null for each position, PER_PAGE per page
let channels = {}; // id -> channel
let page = 0;
let focus = { area: "grid", index: 0 }; // area: grid | buttons; index within the page
let moving = null; // { original } while a channel is being moved
let preview = null; // { from, left, right, back }: tile it zoomed from (null = screen centre), pill actions
let previewChannel = null;
let previewFocus = 1; // 0 = left pill (Menu), 1 = right pill (Start)
let panel = null; // { actions, index, armed }
let updateOffered = false; // the update prompt shows at most once per menu load

function fit() {
  document.documentElement.style.setProperty("--scale", scale());
  placeHand();
}

// ---------- the grid ----------

const slotIndex = () => page * PER_PAGE + focus.index;
const channelAt = (i) => channels[slots[i]] ?? null;

function pageCount() {
  return Math.max(1, Math.ceil(slots.length / PER_PAGE));
}

async function loadHome() {
  const home = await api("/api/home").catch(() => null);
  if (!home || moving) return;
  slots = home.slots;
  channels = home.channels;
  page = Math.min(page, pageCount() - 1);
  renderGrid();
}

function renderGrid() {
  const tiles = [];
  for (let i = 0; i < PER_PAGE; i++) {
    const tile = make("div", "tile");
    const channel = channelAt(page * PER_PAGE + i);
    if (channel) tile.append(banner(channel));
    if (moving && i === focus.index) tile.classList.add("lifted");
    tiles.push(tile);
  }
  $("grid").replaceChildren(...tiles);
  // While moving, a channel may go one page past the last.
  const lastPage = pageCount() - 1 + (moving ? 1 : 0);
  $("arrow-prev").hidden = page === 0;
  $("arrow-next").hidden = page >= lastPage;
  updateFocus();
}

function turnPage(delta, col) {
  const next = page + delta;
  if (next < 0 || next >= pageCount()) return false;
  page = next;
  if (focus.area === "grid" && col !== undefined) {
    focus.index = Math.floor(focus.index / COLS) * COLS + col;
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
        return play(turnPage(dx, dx > 0 ? 0 : COLS - 1) ? "move" : "bump");
      }
      focus.index += dx;
    } else if (row + dy < 0) {
      return play("bump");
    } else if (row + dy >= ROWS) {
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
    if (focus.index === 0) return openSystemPanel();
    return openMessages({ onClose: backToMenu, installUpdate: showUpdatePrompt });
  }
  const channel = channelAt(slotIndex());
  if (!channel) return play("bump");
  previewChannel = channel;
  openPreview(banner(channel), ["Menu", "Start"], $("grid").children[focus.index], {
    left: closePreview,
    right: channel.builtin ? startShop : startChannel,
    back: closePreview,
  });
}

function backToMenu() {
  setMode("menu");
  refreshBadge();
}

views.menu = {
  focused: () => (focus.area === "grid"
    ? $("grid").children[focus.index]
    : [$("btn-system"), $("btn-mail")][focus.index]),
  key(k) {
    if (k.dir) moveMenu(...k.dir);
    else if (k.ok) chooseInMenu();
    else if (k.page) play(turnPage(k.page, focus.area === "grid" ? focus.index % COLS : undefined) ? "move" : "bump");
    else if (k.x) startMoving();
    else if (k.y) openChannelOptions();
  },
};

// ---------- move mode (X) ----------

function startMoving() {
  if (focus.area !== "grid" || !channelAt(slotIndex())) return play("bump");
  moving = { original: [...slots] };
  $("hand").classList.add("grabbing");
  play("select");
  state.mode = "moving";
  renderGrid();
}

// Each step swaps the lifted channel with whatever is next to it.
function moveChannel(dx, dy) {
  const from = slotIndex();
  const col = focus.index % COLS;
  const row = Math.floor(focus.index / COLS);
  let toPage = page;
  let toIndex = focus.index;
  if (dx) {
    if (col + dx < 0 || col + dx >= COLS) {
      toPage = page + dx;
      if (toPage < 0 || toPage > pageCount()) return play("bump");
      toIndex = row * COLS + (dx > 0 ? 0 : COLS - 1);
    } else {
      toIndex += dx;
    }
  } else {
    if (row + dy < 0 || row + dy >= ROWS) return play("bump");
    toIndex += dy * COLS;
  }
  const to = toPage * PER_PAGE + toIndex;
  while (slots.length <= to) slots.push(null);
  [slots[from], slots[to]] = [slots[to], slots[from]];
  page = toPage;
  focus.index = toIndex;
  play("move");
  renderGrid();
}

async function dropChannel(keep) {
  if (!keep) slots = moving.original;
  moving = null;
  $("hand").classList.remove("grabbing");
  while (slots.length && slots[slots.length - 1] === null) slots.pop();
  page = Math.min(page, pageCount() - 1);
  state.mode = "menu";
  renderGrid();
  play(keep ? "select" : "back");
  if (keep) await api("/api/home", { slots }).catch(() => null);
}

views.moving = {
  focused: () => $("grid").children[focus.index],
  key(k) {
    if (k.dir) moveChannel(...k.dir);
    else if (k.ok || k.x) dropChannel(true);
    else if (k.back) dropChannel(false);
  },
};

// ---------- channel options (Y) ----------

function openChannelOptions() {
  const channel = focus.area === "grid" && channelAt(slotIndex());
  if (!channel) return play("bump");
  const actions = [
    { label: "Back", run: closePanel },
    { label: "Move", run: () => { hidePanel(); startMoving(); } },
  ];
  if (!channel.builtin) {
    actions.push({ label: "Delete", confirm: true, run: () => deleteChannel(channel) });
  }
  const note = channel.builtin
    ? "This channel is part of Wii-OS and can't be deleted."
    : "You can get it again from the Channel Shop.";
  openPanel(channel.name, [["", note]], actions);
}

async function deleteChannel(channel) {
  await api("/api/channels/remove", { id: channel.id }).catch(() => null);
  hidePanel();
  play("close");
  await loadHome();
}

// ---------- preview (a channel, or the update prompt) ----------

// Where the preview zooms from and back to: a tile, or the middle of the screen.
function zoomTransform(el) {
  if (!el) return "translate(660px, 371px) scale(0.3125)";
  const r = rectInStage(el);
  return `translate(${r.x}px, ${r.y}px) scale(${r.w / 1920}, ${r.h / 1080})`;
}

function openPreview(content, [leftLabel, rightLabel], from, actions) {
  preview = { from, ...actions };
  previewFocus = 1;
  state.mode = "preview";
  $("preview-banner").replaceChildren(content);
  $("pv-menu").textContent = leftLabel;
  $("pv-start").textContent = rightLabel;
  showPreviewStatus(null);
  const el = $("preview");
  el.hidden = false;
  $("hand").classList.add("hidden");
  document.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
  const anim = el.animate(
    [{ transform: zoomTransform(from), opacity: 0.6 }, { transform: "none", opacity: 1 }],
    { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  $("menu").classList.add("dim");
  play("open");
  anim.onfinish = () => state.mode === "preview" && updateFocus();
}

function closePreview() {
  state.mode = "menu";
  const el = $("preview");
  $("menu").classList.remove("dim");
  play("close");
  const anim = el.animate(
    [{ transform: "none", opacity: 1 }, { transform: zoomTransform(preview.from), opacity: 0.4 }],
    { duration: 320, easing: "cubic-bezier(.5,0,.8,.5)" },
  );
  anim.onfinish = () => {
    el.hidden = true;
    updateFocus();
  };
}

// Swaps the two pills for a message (or back, with null).
function showPreviewStatus(title, detail = "") {
  $("preview").classList.toggle("busy", title !== null);
  $("pv-status-title").textContent = title ?? "";
  $("pv-status-detail").textContent = detail;
}

views.preview = {
  focused: () => [$("pv-menu"), $("pv-start")][previewFocus],
  key(k) {
    if (k.dir && k.dir[0]) {
      const next = previewFocus + k.dir[0];
      if (next < 0 || next > 1) return play("bump");
      previewFocus = next;
      play("move");
      updateFocus();
    } else if (k.ok) {
      if (previewFocus === 0) preview.left();
      else preview.right();
    } else if (k.back) {
      preview.back();
    }
  },
};

views.running = { focused: () => null };

async function startChannel() {
  setMode("running");
  play("start");
  $("flash").classList.add("on");
  await wait(700);
  const res = await api("/api/launch", { id: previewChannel.id }).catch(() => null);
  if (!res?.ok) {
    $("flash").classList.remove("on");
    play("bump");
    setMode("preview");
    return;
  }
  waitForReturn();
}

// The channel runs in its own window on top of this one. Home (handled by
// wiid) or the channel exiting brings us back.
function waitForReturn() {
  const timer = setInterval(async () => {
    const s = await api("/api/state").catch(() => null);
    if (s && s.running === null) {
      clearInterval(timer);
      $("flash").classList.remove("on");
      returnFromChannel();
    }
  }, 800);
}

function returnFromChannel() {
  closePreview();
  setTimeout(offerUpdate, 1500);
}

// The shop runs inside this page, over the preview.
async function startShop() {
  setMode("running");
  play("start");
  $("flash").classList.add("on");
  await wait(500);
  await openShop({
    onClose: () => {
      loadHome();
      refreshBadge();
      returnFromChannel();
    },
    onInstalled: () => refreshBadge(),
  });
  $("flash").classList.remove("on");
}

// ---------- panels ----------

function openPanel(title, lines, actions) {
  panel = { actions, index: 0, armed: null };
  $("panel-title").textContent = title;
  $("panel-body").replaceChildren(...lines.map(([label, value]) => {
    const row = make("div");
    if (label) row.append(`${label}: `, make("b", "", value));
    else row.textContent = value;
    return row;
  }));
  $("panel-actions").replaceChildren(...actions.map((a) => make("div", "pill", a.label)));
  $("panel").hidden = false;
  $("menu").classList.add("dim");
  play("open");
  setMode("panel");
}

function hidePanel() {
  $("panel").hidden = true;
  $("menu").classList.remove("dim");
  setMode("menu");
}

function closePanel() {
  hidePanel();
  play("back");
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

views.panel = {
  focused: () => $("panel-actions").children[panel.index],
  key(k) {
    if (k.dir && k.dir[1]) {
      const next = panel.index + k.dir[1];
      if (next < 0 || next >= panel.actions.length) return play("bump");
      disarm();
      panel.index = next;
      play("move");
      updateFocus();
    } else if (k.ok) {
      choosePanel();
    } else if (k.back) {
      closePanel();
    }
  },
};

async function power(action) {
  $("flash").classList.add("on");
  await api("/api/power", { action }).catch(() => null);
}

async function openSystemPanel() {
  const info = await api("/api/system").catch(() => ({}));
  openPanel("wii-os", [
    ["Name", info.hostname ?? "unknown"],
    ["Address", info.ip ?? "not connected"],
    ["Version", info.version ?? "development copy"],
  ], [
    { label: "Back", run: closePanel },
    { label: "Check for updates", run: checkForUpdates },
    { label: "Restart menu", run: () => power("restart-menu") },
    { label: "Restart", run: () => power("reboot"), confirm: true },
    { label: "Power off", run: () => power("poweroff"), confirm: true },
  ]);
}

// ---------- system updates ----------

// Offers a new release, but only while the menu itself is on screen.
async function offerUpdate() {
  if (state.mode !== "menu" || updateOffered) return;
  const s = await api("/api/update").catch(() => null);
  if (s?.available && state.mode === "menu") showUpdatePrompt(s.available);
  refreshBadge(); // the check may have left a message
}

function updateBanner(release) {
  const div = make("div", "banner banner-update");
  const notes = make("ul");
  notes.append(...release.notes.map((n) => make("li", "", n)));
  div.append(
    make("span", "up-icon"),
    make("h2", "", "A system update is available"),
    make("p", "up-version", `Wii-OS ${release.version}`),
    notes,
    make("p", "up-hint", "You can also update later from your messages or the OS menu."),
  );
  return div;
}

function showUpdatePrompt(release) {
  updateOffered = true;
  const decline = () => {
    api("/api/update/decline", {}).catch(() => null);
    closePreview();
  };
  openPreview(updateBanner(release), ["Not now", "Update"], null, {
    left: decline,
    right: () => installUpdate(release),
    back: decline,
  });
}

async function installUpdate(release) {
  setMode("updating");
  play("start");
  showPreviewStatus(`Updating to ${release.version}...`,
    "This takes a few minutes. Keep the TV on. It restarts by itself when it's done.");
  const res = await api("/api/update/install", {}).catch(() => null);
  if (!res?.ok) return updateFailed();
  // On success wiid restarts the whole session, so this page just goes away.
  const timer = setInterval(async () => {
    const s = await api("/api/update").catch(() => null);
    if (s?.status === "failed") {
      clearInterval(timer);
      updateFailed();
    }
  }, 2000);
}

function updateFailed() {
  setMode("update-failed");
  play("bump");
  showPreviewStatus("The update didn't install.", "Nothing was changed. Press A to go back.");
}

views.updating = { focused: () => null };
views["update-failed"] = {
  focused: () => null,
  key(k) {
    if (k.ok || k.back) closePreview();
  },
};

async function checkForUpdates() {
  $("panel-actions").children[panel.index].textContent = "Checking...";
  const s = await api("/api/update/check", {}).catch(() => null);
  if (s?.available) {
    $("panel").hidden = true;
    showUpdatePrompt(s.available);
    return;
  }
  let message = `You're up to date (${s?.version}).`;
  if (!s || s.error) {
    message = s && !s.enabled ? "Updates are off on this copy." : "Couldn't reach the update server.";
  }
  openPanel("System update", [["", message]], [{ label: "Back", run: closePanel }]);
}

// ---------- welcome + input ----------

views.welcome = {
  focused: () => null,
  key(k) {
    if (!k.ok) return;
    $("welcome").classList.add("gone");
    play("welcome");
    setMode("menu");
    setTimeout(offerUpdate, 1500);
  },
};

addEventListener("keydown", (ev) => {
  ev.preventDefault();
  const k = keyOf(ev);
  if (k.repeat && !k.dir && !k.page) return; // only movement auto-repeats
  views[state.mode]?.key?.(k);
});

// ---------- start ----------

fit();
addEventListener("resize", fit);
startClock($("clock"), $("date"));
await loadHome();
refreshBadge();
setInterval(offerUpdate, 60 * 1000);
setInterval(() => state.mode === "menu" && (loadHome(), refreshBadge()), 30 * 1000);

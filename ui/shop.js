// The Channel Shop: browse the catalog and add channels to the home menu.
// It runs inside the menu page, with its own music that plays only while the
// shop is open.
import { play } from "./sounds.js";
import { banner } from "./banners.js";
import { $, api, make, setMode, state, updateFocus, views } from "./core.js";

const COLS = 3;
const VISIBLE_ROWS = 2;
const ROW_HEIGHT = 372; // card height + gap, in stage pixels

let items = [];
let index = 0;
let callbacks = null;
let homeTimer = null;
let pollTimer = null;

export async function openShop(cb) {
  callbacks = cb;
  index = 0;
  items = await api("/api/shop").catch(() => []);
  render();
  $("shop").hidden = false;
  const music = $("shop-music");
  music.currentTime = 0;
  music.play().catch(() => {});
  setMode("shop");

  // Home closes channels in wiid; the shop lives in this page, so watch for it.
  const start = (await api("/api/state").catch(() => ({}))).home_presses;
  homeTimer = setInterval(async () => {
    const s = await api("/api/state").catch(() => null);
    if (s && s.home_presses !== start) close();
  }, 600);
}

function close() {
  clearInterval(homeTimer);
  clearInterval(pollTimer);
  const music = $("shop-music");
  music.pause();
  $("shop").hidden = true;
  play("back");
  callbacks.onClose();
}

function status(item) {
  if (item.job === "downloading") return "Downloading...";
  if (item.job === "failed") return "Couldn't download. Try again";
  if (item.installed) return "On your menu";
  return "Get";
}

function render() {
  const cards = items.map((item) => {
    const card = make("div", "shop-card");
    card.dataset.hand = "0.8,0.22"; // on the artwork, clear of the text
    card.classList.toggle("owned", item.installed);
    card.classList.toggle("busy", item.job === "downloading");
    const art = make("div", "shop-art");
    art.append(banner(item));
    card.append(art, make("div", "shop-name", item.name), make("div", "shop-desc", item.description ?? ""),
      make("div", "shop-status", status(item)));
    return card;
  });
  $("shop-grid").replaceChildren(...cards);
  if (!items.length) $("shop-grid").append(make("div", "shop-empty", "The shop couldn't load. Try again later."));
  const row = Math.floor(index / COLS);
  const top = Math.max(0, row - (VISIBLE_ROWS - 1));
  $("shop-grid").style.transform = `translateY(${-top * ROW_HEIGHT}px)`;
  if (state.mode === "shop") updateFocus();
}

async function get(item) {
  if (item.installed || item.job === "downloading") return play("bump");
  play("select");
  const res = await api("/api/shop/install", { id: item.id }).catch(() => null);
  if (!res?.ok) return play("bump");
  item.job = "downloading";
  render();
  clearInterval(pollTimer);
  pollTimer = setInterval(watchDownloads, 1000);
}

async function watchDownloads() {
  const fresh = await api("/api/shop").catch(() => null);
  if (!fresh) return;
  for (const item of fresh) {
    const before = items.find((i) => i.id === item.id);
    if (item.installed && before && !before.installed) {
      play("start");
      toast(`${item.name} was added to your home menu.`);
      callbacks.onInstalled();
    }
    if (item.job === "failed" && before?.job === "downloading") play("bump");
  }
  items = fresh;
  render();
  if (!items.some((i) => i.job === "downloading")) clearInterval(pollTimer);
}

function toast(text) {
  const t = $("shop-toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove("show"), 3500);
}

views.shop = {
  focused: () => $("shop-grid").children[index] ?? null,
  key(k) {
    if (k.dir) {
      const [dx, dy] = k.dir;
      const col = index % COLS;
      let next = index;
      if (dx && col + dx >= 0 && col + dx < COLS) next = index + dx;
      if (dy) next = index + dy * COLS;
      if (next === index || next < 0 || next >= items.length) return play("bump");
      index = next;
      play("move");
      render();
    } else if (k.ok && items[index]) {
      get(items[index]);
    } else if (k.back) {
      close();
    }
  },
};

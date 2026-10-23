// Shared plumbing for the menu, the shop and the message board: the current
// mode, which element has focus (and the pointer hand on it), and input.
//
// Each screen registers a view for its mode: { focused() -> element, key(k) }.
// wiid turns the controller into keys: arrows, Enter (A), Escape (B), x (X),
// y (Y) and PageUp/PageDown (bumpers).

export const $ = (id) => document.getElementById(id);
export const stage = $("stage");
export const state = { mode: "welcome" };
export const views = {};

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function make(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, options);
  return res.json();
}

export function scale() {
  return Math.min(innerWidth / 1920, innerHeight / 1080);
}

export function rectInStage(el) {
  const s = scale();
  const st = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: (r.left - st.left) / s, y: (r.top - st.top) / s, w: r.width / s, h: r.height / s };
}

export function setMode(mode) {
  state.mode = mode;
  updateFocus();
}

export function focusedEl() {
  return views[state.mode]?.focused?.() ?? null;
}

export function updateFocus() {
  document.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
  focusedEl()?.classList.add("focused");
  placeHand();
}

export function placeHand() {
  const hand = $("hand");
  const el = focusedEl();
  if (!el) {
    hand.classList.add("hidden");
    return;
  }
  hand.classList.remove("hidden");
  const r = rectInStage(el);
  // Where on the element the fingertip goes, as fractions of its size.
  // Elements can choose with data-hand="x,y" so the hand doesn't hide text.
  const [fx, fy] = el.dataset.hand
    ? el.dataset.hand.split(",").map(Number)
    : [0.62, el.classList.contains("round-btn") ? 0.3 : 0.55];
  hand.style.transform = `translate(${r.x + r.w * fx - 46}px, ${r.y + r.h * fy}px)`;
}

const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function keyOf(ev) {
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  return {
    dir: DIRS[key] ?? null,
    ok: key === "Enter" || key === " ",
    back: key === "Escape" || key === "Backspace",
    x: key === "x",
    y: key === "y",
    page: key === "PageUp" ? -1 : key === "PageDown" ? 1 : 0,
    repeat: ev.repeat,
  };
}

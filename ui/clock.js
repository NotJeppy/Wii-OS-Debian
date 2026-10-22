// Seven-segment clock and date for the bottom bar.
const W = 56, H = 100, T = 12, G = 2.5;
const SVG_NS = "http://www.w3.org/2000/svg";

// Segments a..g as hexagons.
function hSeg(y) {
  const x1 = T / 2 + G, x2 = W - T / 2 - G, h = T / 2;
  return [[x1, y], [x1 + h, y - h], [x2 - h, y - h], [x2, y], [x2 - h, y + h], [x1 + h, y + h]];
}
function vSeg(x, y1, y2) {
  const h = T / 2;
  return [[x, y1], [x + h, y1 + h], [x + h, y2 - h], [x, y2], [x - h, y2 - h], [x - h, y1 + h]];
}
const SEGMENTS = {
  a: hSeg(T / 2),
  b: vSeg(W - T / 2, T / 2 + G, H / 2 - G),
  c: vSeg(W - T / 2, H / 2 + G, H - T / 2 - G),
  d: hSeg(H - T / 2),
  e: vSeg(T / 2, H / 2 + G, H - T / 2 - G),
  f: vSeg(T / 2, T / 2 + G, H / 2 - G),
  g: hSeg(H / 2),
};
const DIGITS = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg", " ": "",
};

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function digit() {
  const svg = el("svg", { viewBox: `-2 -2 ${W + 4} ${H + 4}`, width: W + 4 });
  const segs = {};
  for (const [name, pts] of Object.entries(SEGMENTS)) {
    segs[name] = el("polygon", { points: pts.map((p) => p.join(",")).join(" "), class: "seg off" });
    svg.append(segs[name]);
  }
  return {
    svg,
    set(ch) {
      const on = DIGITS[ch] ?? "";
      for (const [name, poly] of Object.entries(segs)) poly.classList.toggle("off", !on.includes(name));
    },
  };
}

export function startClock(clockEl, dateEl) {
  const digits = [digit(), digit(), digit(), digit()];
  const colon = el("svg", { viewBox: `0 0 20 ${H + 4}`, width: 20 });
  colon.append(el("circle", { cx: 10, cy: 32, r: 7, class: "colon" }), el("circle", { cx: 10, cy: 72, r: 7, class: "colon" }));
  const ampm = document.createElement("div");
  ampm.className = "ampm";
  clockEl.append(digits[0].svg, digits[1].svg, colon, digits[2].svg, digits[3].svg, ampm);

  function tick() {
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const text = String(h).padStart(2, " ") + String(now.getMinutes()).padStart(2, "0");
    [...text].forEach((ch, i) => digits[i].set(ch));
    ampm.textContent = now.getHours() < 12 ? "AM" : "PM";
    for (const dot of colon.children) dot.classList.toggle("blink", now.getSeconds() % 2 === 1);
    const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
    dateEl.textContent = `${weekday} ${now.getMonth() + 1}/${now.getDate()}`;
  }
  tick();
  setInterval(tick, 1000);
}

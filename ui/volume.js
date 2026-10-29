// Volume indicator, shown when the volume changes (a remote's volume buttons).
// wiid injects this into the menu and every web channel, in the same isolated
// world as the on-screen keyboard, and calls __wiiVolume(percent, muted) over
// the DevTools pipe. Only the top frame draws it.
(() => {
  if (window.__wiiVolume || window !== window.top) return;

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .wrap { position: fixed; top: calc(var(--u) * 60); right: calc(var(--u) * 70); z-index: 2147483647;
      display: flex; align-items: center; gap: calc(var(--u) * 22); pointer-events: none;
      padding: calc(var(--u) * 18) calc(var(--u) * 30) calc(var(--u) * 18) calc(var(--u) * 24);
      border-radius: calc(var(--u) * 60); background: linear-gradient(#ffffff, #e9ebef);
      border: calc(var(--u) * 5) solid #34b1e8; box-shadow: 0 calc(var(--u) * 14) calc(var(--u) * 40) rgba(0,0,0,0.35);
      font-family: "Quicksand", "Noto Sans", sans-serif; color: #45474d;
      opacity: 0; transform: translateY(calc(var(--u) * -30)) scale(0.9);
      transition: opacity 0.25s, transform 0.3s cubic-bezier(0.2, 1.4, 0.4, 1); }
    .wrap.show { opacity: 1; transform: none; }
    .wrap.bump .num { animation: bump 0.25s; }
    @keyframes bump { 40% { transform: scale(1.15); } }
    svg { width: calc(var(--u) * 56); height: calc(var(--u) * 56); flex: none; }
    .bar { width: calc(var(--u) * 300); height: calc(var(--u) * 22); border-radius: calc(var(--u) * 11);
      background: #d5d7dc; overflow: hidden; box-shadow: inset 0 calc(var(--u) * 2) calc(var(--u) * 4) rgba(0,0,0,0.15); }
    .fill { height: 100%; border-radius: inherit; background: linear-gradient(#7fd3f7, #34b1e8);
      transition: width 0.2s ease-out; }
    .muted .fill { background: #a3a5ab; }
    .num { min-width: calc(var(--u) * 110); text-align: right; font-size: calc(var(--u) * 44); font-weight: 700; }
  `);
  root.adoptedStyleSheets = [sheet];

  const svgNS = "http://www.w3.org/2000/svg";
  function shape(tag, attrs) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  const icon = shape("svg", { viewBox: "0 0 24 24" });
  icon.append(shape("path", { d: "M4 9h4l5-4v14l-5-4H4z", fill: "#34b1e8" }));
  const waves = [
    shape("path", { d: "M16 9.5a3.5 3.5 0 0 1 0 5", stroke: "#34b1e8", "stroke-width": "2", fill: "none", "stroke-linecap": "round" }),
    shape("path", { d: "M18.5 7a7 7 0 0 1 0 10", stroke: "#34b1e8", "stroke-width": "2", fill: "none", "stroke-linecap": "round" }),
  ];
  const cross = shape("path", { d: "M16.5 9.5l5 5m0-5l-5 5", stroke: "#a3a5ab", "stroke-width": "2", "stroke-linecap": "round" });
  icon.append(...waves, cross);

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = "fill";
  bar.append(fill);
  const num = document.createElement("div");
  num.className = "num";
  wrap.append(icon, bar, num);
  root.append(wrap);

  let hideTimer = null;
  window.__wiiVolume = (percent, muted) => {
    host.style.setProperty("--u", `${Math.max(0.5, innerWidth / 1920)}px`);
    if (!host.isConnected) (document.body || document.documentElement).append(host);
    wrap.classList.toggle("muted", muted);
    fill.style.width = `${percent}%`;
    num.textContent = muted ? "Muted" : `${percent}%`;
    waves[0].style.display = !muted && percent > 0 ? "" : "none";
    waves[1].style.display = !muted && percent >= 50 ? "" : "none";
    cross.style.display = muted || percent === 0 ? "" : "none";
    wrap.classList.remove("bump");
    void wrap.offsetWidth; // restart the bump
    wrap.classList.add("show", "bump");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => wrap.classList.remove("show"), 1800);
  };
})();

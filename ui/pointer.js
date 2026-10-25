// Injected into channels with a right-stick pointer (the Internet channel).
// wiid moves a real mouse with the right stick; the system cursor is
// invisible on the TV, so this draws the menu's pointing hand where the mouse
// is. It hides when the D-pad takes over or the on-screen keyboard opens.
(() => {
  if (window.__wiiPointer) return;
  window.__wiiPointer = true;

  const SVG = "http://www.w3.org/2000/svg";
  // The fingertip, in the hand's 100 x 124 drawing.
  const TIP_X = 48;
  const TIP_Y = 4;

  function shape(name, attrs) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // The same hand as the menu's (index.html): an outline drawn underneath,
  // then the white fill, then the cuff.
  function hand() {
    const svg = shape("svg", { viewBox: "0 0 100 124", width: "100", height: "124" });
    const parts = [
      ["rect", { x: 36, y: 4, width: 24, height: 64, rx: 12 }],
      ["circle", { cx: 68, cy: 56, r: 11 }],
      ["circle", { cx: 80, cy: 64, r: 10 }],
      ["ellipse", { cx: 24, cy: 74, rx: 11, ry: 19, transform: "rotate(-32 24 74)" }],
      ["rect", { x: 24, y: 48, width: 66, height: 60, rx: 24 }],
    ];
    const outline = shape("g", { fill: "#34b1e8", stroke: "#34b1e8", "stroke-width": 10 });
    const fill = shape("g", { fill: "#ffffff" });
    for (const [name, attrs] of parts) {
      outline.append(shape(name, attrs));
      fill.append(shape(name, attrs));
    }
    outline.append(shape("rect", { x: 34, y: 100, width: 46, height: 18, rx: 6 }));
    svg.append(outline, fill, shape("rect", { x: 34, y: 100, width: 46, height: 18, rx: 6, fill: "#c9ecfb" }));
    return svg;
  }

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .hand { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none;
      transform-origin: ${TIP_X}px ${TIP_Y}px; filter: drop-shadow(0 6px 6px rgba(0,0,0,0.3));
      transition: opacity 0.2s; will-change: transform; }
    .hand.hidden { opacity: 0; }
  `);
  root.adoptedStyleSheets = [sheet];
  const el = document.createElement("div");
  el.className = "hand hidden";
  el.append(hand());
  root.append(el);

  let attached = false;
  let keyboardOpen = false;

  function place(x, y) {
    if (!attached) {
      (document.body || document.documentElement).append(host);
      attached = true;
    }
    const s = Math.max(0.5, innerWidth / 1920) * 0.8;
    el.style.transform = `translate(${x - TIP_X}px, ${y - TIP_Y}px) scale(${s}) rotate(-14deg)`;
    el.classList.remove("hidden");
  }

  const hide = () => el.classList.add("hidden");

  addEventListener("mousemove", (e) => {
    if (!keyboardOpen) place(e.clientX, e.clientY);
  }, true);
  // Into a frame (which draws its own hand) or out of the window.
  addEventListener("mouseout", (e) => {
    if (!e.relatedTarget || e.relatedTarget.tagName === "IFRAME") hide();
  }, true);
  addEventListener("keydown", (e) => {
    if (e.key.startsWith("Arrow")) hide(); // the D-pad has taken over
  }, true);
  addEventListener("wii-osk-open", () => { keyboardOpen = true; hide(); });
  addEventListener("wii-osk-close", () => { keyboardOpen = false; });
})();

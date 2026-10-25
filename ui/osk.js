// On-screen keyboard for web channels with ordinary sign-in forms (Netflix,
// Disney+, Hulu). wiid injects this into every page and frame of those
// channels through Chrome's DevTools pipe, in an isolated world, so the site's
// own scripts can't see or break it.
//
// Move to a text field with the D-pad and press A (or click it with the
// right-stick pointer): the keyboard opens.
//   D-pad  move between keys      A  press the key
//   B      close the keyboard     X  delete      Y  shift
// Someone typing on a real keyboard never gets it.
(() => {
  if (window.__wiiOsk) return;
  window.__wiiOsk = true;

  const TEXT_TYPES = new Set(["", "text", "email", "password", "search", "tel", "url", "number"]);
  const LAYOUTS = {
    letters: ["1234567890", "qwertyuiop", "asdfghjkl@", "zxcvbnm.-_"],
    symbols: ["!#$%^&*()+", "=[]{}\\|;:'", "\"<>,?/~`€£"],
  };
  const BOTTOM = [
    ["shift", "Shift"], ["mode", "#+="], [".com", ".com"], [" ", "Space"], ["back", "Delete"], ["done", "Done"],
    ["enter", "Enter"],
  ];

  let open = false;
  let target = null;
  let shift = false;
  let mode = "letters";
  let rows = []; // rows of { el, value }
  let sel = { r: 1, c: 0 };
  let realKeyboard = false;

  // ---------- finding the field ----------

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isText(el) {
    if (!el) return false;
    if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
    return el instanceof HTMLTextAreaElement || el.isContentEditable;
  }

  // ---------- drawing ----------

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .wrap { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647; display: flex;
      justify-content: center; padding-bottom: calc(var(--u) * 28); pointer-events: none;
      font-family: "Quicksand", "Noto Sans", sans-serif; }
    .panel { pointer-events: auto; padding: calc(var(--u) * 26) calc(var(--u) * 30); border-radius: calc(var(--u) * 34);
      background: linear-gradient(#ffffff, #e9ebef); border: calc(var(--u) * 5) solid #34b1e8;
      box-shadow: 0 calc(var(--u) * 16) calc(var(--u) * 50) rgba(0,0,0,0.45); }
    .preview { height: calc(var(--u) * 64); margin: 0 calc(var(--u) * 6) calc(var(--u) * 18); padding: 0 calc(var(--u) * 24);
      border-radius: calc(var(--u) * 18); background: #fff; border: calc(var(--u) * 3) solid #c7c8ce; color: #45474d;
      font-size: calc(var(--u) * 34); line-height: calc(var(--u) * 60); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; direction: ltr; }
    .preview.empty { color: #a3a5ab; }
    .row { display: flex; justify-content: center; gap: calc(var(--u) * 10); margin-bottom: calc(var(--u) * 10); }
    .key { min-width: calc(var(--u) * 84); height: calc(var(--u) * 78); padding: 0 calc(var(--u) * 14); box-sizing: border-box;
      border-radius: calc(var(--u) * 18); background: linear-gradient(#ffffff, #e2e3e7); border: calc(var(--u) * 4) solid #c7c8ce;
      color: #45474d; font-size: calc(var(--u) * 38); font-weight: 700; display: flex; align-items: center;
      justify-content: center; transition: transform 0.1s; }
    .key.wide { min-width: calc(var(--u) * 150); font-size: calc(var(--u) * 30); }
    .key.space { min-width: calc(var(--u) * 280); }
    .key.on { background: linear-gradient(#bfe6fa, #8fd2f3); }
    .key.sel { border-color: #34b1e8; transform: scale(1.08); box-shadow: 0 0 0 calc(var(--u) * 5) rgba(52,177,232,0.4); }
    .hint { margin-top: calc(var(--u) * 6); text-align: center; color: #8d8f96; font-size: calc(var(--u) * 24); }
  `);
  root.adoptedStyleSheets = [sheet];
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const panel = document.createElement("div");
  panel.className = "panel";
  const preview = document.createElement("div");
  preview.className = "preview";
  const keysBox = document.createElement("div");
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "A type  ·  B close  ·  X delete  ·  Y shift";
  hint.style.whiteSpace = "pre";
  panel.append(preview, keysBox, hint);
  wrap.append(panel);
  root.append(wrap);

  function key(value, label, extra = "") {
    const el = document.createElement("div");
    el.className = `key ${extra}`;
    el.textContent = label;
    return { el, value };
  }

  function build() {
    rows = [];
    keysBox.replaceChildren();
    for (const line of LAYOUTS[mode]) {
      const row = [...line].map((ch) => key(ch, shift && mode === "letters" ? ch.toUpperCase() : ch));
      rows.push(row);
    }
    rows.push(BOTTOM.map(([value, label]) => {
      const text = value === "mode" ? (mode === "letters" ? "#+=" : "abc") : label;
      const k = key(value, text, value === " " ? "wide space" : "wide");
      if (value === "shift" && shift) k.el.classList.add("on");
      return k;
    }));
    for (const row of rows) {
      const div = document.createElement("div");
      div.className = "row";
      div.append(...row.map((k) => k.el));
      keysBox.append(div);
    }
    sel.r = Math.min(sel.r, rows.length - 1);
    sel.c = Math.min(sel.c, rows[sel.r].length - 1);
    paint();
  }

  function paint() {
    rows.flat().forEach((k) => k.el.classList.remove("sel"));
    rows[sel.r][sel.c].el.classList.add("sel");
    const value = target ? (target.isContentEditable ? target.textContent : target.value) : "";
    const hidden = target instanceof HTMLInputElement && target.type === "password";
    const label = fieldLabel(target);
    preview.classList.toggle("empty", !value);
    preview.textContent = value ? (hidden ? "•".repeat(value.length) : value) : label;
  }

  // What the field is called on screen, for the empty preview line.
  function fieldLabel(field) {
    if (!field) return "Type here";
    const labelled = field.getAttribute("aria-labelledby");
    const byId = labelled && document.getElementById(labelled.split(" ")[0]);
    const text = field.getAttribute("aria-label") || byId?.textContent || field.labels?.[0]?.textContent
      || field.placeholder;
    return text?.trim() || "Type here";
  }

  function sizeTo() {
    host.style.setProperty("--u", `${Math.max(0.5, innerWidth / 1920)}px`);
  }

  // ---------- typing ----------

  function insert(text) {
    target.focus();
    const before = target.value;
    if (!document.execCommand("insertText", false, text) && "value" in target && target.value === before) {
      // Fallback for fields that refuse execCommand: set the value the way a
      // real keystroke would, so the site's own scripts notice.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value").set;
      setter.call(target, before + text);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function backspace() {
    target.focus();
    const before = target.value;
    if (!document.execCommand("delete", false) && "value" in target && target.value === before && before) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value").set;
      setter.call(target, before.slice(0, -1));
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function press(k) {
    switch (k.value) {
      case "shift": shift = !shift; build(); return;
      case "mode": mode = mode === "letters" ? "symbols" : "letters"; build(); return;
      case "back": backspace(); break;
      case "done": hide(); return;
      case "enter": hide(); submit(); return;
      default: {
        insert(shift && mode === "letters" ? k.value.toUpperCase() : k.value);
        if (shift) { shift = false; build(); }
      }
    }
    paint();
  }

  // Like pressing Enter in the field: submit its form (search, sign in...).
  function submit() {
    const form = target?.form;
    if (form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return;
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      target?.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  // Up and down go to the key nearest in the next row.
  function move(dx, dy) {
    if (dx) {
      sel.c = (sel.c + dx + rows[sel.r].length) % rows[sel.r].length;
    } else {
      const r = sel.r + dy;
      if (r < 0 || r >= rows.length) return;
      const box = rows[sel.r][sel.c].el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      let best = 0;
      rows[r].forEach((k, i) => {
        const b = k.el.getBoundingClientRect();
        const bb = rows[r][best].el.getBoundingClientRect();
        if (Math.abs(b.left + b.width / 2 - x) < Math.abs(bb.left + bb.width / 2 - x)) best = i;
      });
      sel = { r, c: best };
    }
    paint();
  }

  // ---------- open / close ----------

  // Tells wiid (the right-stick pointer rests while we're open) and the
  // pointer hand in this page.
  function announce(isOpen) {
    try {
      __wiiNotify(JSON.stringify({ keyboard: isOpen })); // eslint-disable-line no-undef
    } catch {
      // not running under wiid
    }
    dispatchEvent(new Event(isOpen ? "wii-osk-open" : "wii-osk-close"));
  }

  function show(field) {
    target = field;
    open = true;
    announce(true);
    shift = false;
    mode = "letters";
    sel = { r: 1, c: 0 };
    sizeTo();
    (document.body || document.documentElement).append(host);
    build();
    field.scrollIntoView({ block: "center" });
  }

  function hide() {
    open = false;
    announce(false);
    host.remove();
    target?.focus();
  }

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  const MOVES = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  addEventListener("keydown", (e) => {
    // Letters other than x and y (which the controller sends) mean a real keyboard.
    if (e.key.length === 1 && !"xyXY".includes(e.key)) realKeyboard = true;
    if (!open) {
      const field = deepActive();
      if (e.key === "Enter" && !realKeyboard && isText(field)) {
        swallow(e);
        show(field);
      }
      return;
    }
    swallow(e);
    if (!target.isConnected) return hide();
    if (MOVES[e.key]) move(...MOVES[e.key]);
    else if (e.key === "Enter") press(rows[sel.r][sel.c]);
    else if (e.key === "Escape") hide();
    else if (e.key === "x" || e.key === "Backspace") { backspace(); paint(); }
    else if (e.key === "y") { shift = !shift; build(); }
  }, true);

  // Clicking a text field with the right-stick pointer opens the keyboard too.
  addEventListener("click", (e) => {
    if (open || realKeyboard || !e.isTrusted) return;
    setTimeout(() => {
      const field = deepActive();
      if (!open && isText(field)) show(field);
    }, 0);
  }, true);

  for (const type of ["keyup", "keypress"]) {
    addEventListener(type, (e) => { if (open) swallow(e); }, true);
  }
  addEventListener("resize", () => open && sizeTo());
  // Leaving the page with the keyboard open mustn't leave the pointer off.
  addEventListener("pagehide", () => open && announce(false));
})();

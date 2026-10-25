// Injected into the Internet channel, after the on-screen keyboard:
//   B (Escape)  go back a page          Y  go to the start page
// Links that would open a new window open in place instead: the kiosk shows
// one window at a time, and a new one would have no way back.
(() => {
  if (window.__wiiBrowser) return;
  window.__wiiBrowser = true;

  const START = "http://127.0.0.1:8770/browser/";

  function typing() {
    const a = document.activeElement;
    return a && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA");
  }

  // The on-screen keyboard swallows keys while it's open, so these only see
  // keys meant for the page.
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      history.back();
    } else if (e.key === "y" && !typing() && window.top === window) {
      e.preventDefault(); // (a frame can't move the whole tab, so frames leave Y alone)
      location.href = START;
    }
  }, true);

  addEventListener("click", (e) => {
    const link = e.target.closest?.("a[target]");
    if (link && link.target !== "_self") link.target = "_self";
  }, true);
})();

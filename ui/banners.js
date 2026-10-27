// Channel artwork, drawn in CSS (see "banners" in style.css).
import { make } from "./core.js";

// Hand-drawn banners for known channels: [logo mark class, wordmark].
const BANNERS = {
  youtube: ["yt-logo", "YouTube"],
  twitch: ["tw-logo", "twitch"],
  plex: ["px-logo", "plex"],
  netflix: ["", "NETFLIX"],
  disney: ["", "Disney+"],
  hulu: ["", "hulu"],
  moonlight: ["moon-logo", "Moonlight"],
  internet: ["globe-logo", "Internet"],
  shop: ["shop-bag", "Channel Shop"],
  settings: ["gear-logo", "Settings"],
};

export function banner(channel) {
  const div = make("div", "banner");
  const known = BANNERS[channel.banner];
  if (known) {
    div.classList.add(`banner-${channel.banner}`);
    div.append(make("span", known[0]), make("span", "wordmark", known[1]));
  } else {
    div.classList.add("banner-generic");
    div.style.background = channel.color || "linear-gradient(#5ab9ea, #2b7fc0)";
    div.textContent = channel.name;
  }
  return div;
}

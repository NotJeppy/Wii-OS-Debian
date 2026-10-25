// The Internet channel's start page: search, or go to an address.
const form = document.getElementById("go");
const input = document.getElementById("address");

// Something like "example.com" or "https://..." is an address; anything else is a search.
function destination(text) {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^[^.]+\.[^.]{2,}/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (input.value.trim()) location.href = destination(input.value);
});

input.focus();

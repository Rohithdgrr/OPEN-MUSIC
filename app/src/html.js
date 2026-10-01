// html.js — HTML escaping, the single choke point for API data entering
// innerHTML (review 5.5 XSS). DOM-free by design so `node --test` can
// import it directly (core.js pulls in the whole app graph and touches
// window/document at module scope).
//
// Every value that ever came from the API must pass through esc() — in text
// position AND inside attributes/URLs. It escapes quotes too, so
// `attr="${esc(x)}"` is injection-safe. Never interpolate raw data.
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

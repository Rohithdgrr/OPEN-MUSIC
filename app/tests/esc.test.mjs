// XSS escaping contract (review 5.5): esc() must neutralize every byte an
// API value can carry into an innerHTML template — markup, quotes (both
// attribute and JS-string contexts), and ampersands must not double-decode
// into markup. Run with: npm test (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";

import { esc } from "../src/html.js";

test("esc neutralizes markup", () => {
  assert.equal(
    esc('<script>alert("xss")</script>'),
    "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
  );
  assert.equal(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
});

test("esc is attribute-context safe (quotes)", () => {
  assert.equal(esc('" onmouseover="evil()'), "&quot; onmouseover=&quot;evil()");
  assert.equal(esc("' onfocus='evil()"), "&#39; onfocus=&#39;evil()");
});

test("esc escapes ampersands so entities cannot be smuggled", () => {
  assert.equal(esc("&lt;script&gt;"), "&amp;lt;script&amp;gt;");
  assert.equal(esc("AT&T"), "AT&amp;T");
});

test("esc tolerates nullish and non-string input", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
  assert.equal(esc("日本語 🎵"), "日本語 🎵", "unicode passes through unchanged");
});

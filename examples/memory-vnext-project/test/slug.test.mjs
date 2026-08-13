import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSlug } from "../src/slug.mjs";

test("normalizes accents, punctuation, and repeated separators", () => {
  assert.equal(normalizeSlug("  Déjà Vu — API!  "), "deja-vu-api");
});

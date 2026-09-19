import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AWS ids are strings ("tbl_...", "item_food_card_...", "cat_food_card_...").
 * A page script that wraps one in Number() gets NaN: category tabs filter to
 * nothing, table selection silently fails, cart lines lose their item_id (so
 * stock is never deducted). The Flask-era scripts used integer ids, which is
 * how this slipped through the port. These patterns must never come back.
 */
const DIR = join(__dirname, "../../hosting/js");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".js"));
const FORBIDDEN: Array<[RegExp, string]> = [
  [/Number\(\s*[\w.]*dataset\.(id|tableId|sessionId|orderId|itemId|categoryId)\s*\)/, "Number(dataset.<id>)"],
  [/Number\(\s*form\.category_id\.value\s*\)/, "Number(form.category_id.value)"],
  [/Number\(\s*(ACTIVE_TABLE|table|item|session)\.(table_id|id)\s*\)/, "Number(<entity>.id)"],
  [/activeCategoryId\s*=\s*[^;]*Number\(/, "activeCategoryId = Number(...)"],
];

test("page scripts never coerce string ids with Number()", () => {
  assert.ok(FILES.length > 10, "expected the page scripts to be present");
  const hits: string[] = [];
  for (const f of FILES) {
    const lines = readFileSync(join(DIR, f), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, label] of FORBIDDEN) if (re.test(line)) hits.push(`${f}:${i + 1} ${label}`);
    });
  }
  assert.deepEqual(hits, [], "numeric coercion of string ids found:\n" + hits.join("\n"));
});

import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool, withTransaction } from "../src/lib/db";
import { nextNumber } from "../src/lib/counters";
import { resetDb } from "./_helpers";

before(async () => { await getPool(); });
beforeEach(resetDb);

test("nextNumber: sequential calls never repeat and never skip", async () => {
  const nums: number[] = [];
  for (let i = 0; i < 5; i++) {
    const { number } = await withTransaction((c) => nextNumber(c, "foodBill"));
    nums.push(number);
  }
  assert.deepEqual(nums, [1, 2, 3, 4, 5]);
});

test("nextNumber: N concurrent transactions produce N unique, contiguous numbers (no dup, no gap)", async () => {
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, () => withTransaction((c) => nextNumber(c, "qrOrder"))),
  );
  const nums = results.map((r) => r.number).sort((a, b) => a - b);
  assert.equal(new Set(nums).size, N, "no duplicate numbers issued under concurrency");
  assert.deepEqual(nums, Array.from({ length: N }, (_, i) => i + 1), "numbers are contiguous 1..N, no gaps");
});

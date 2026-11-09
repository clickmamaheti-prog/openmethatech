// Unit tests for the model picker logic (src/ui/picker.ts).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  groupCatalog,
  flattenGroups,
  pickerNext,
  pickerPrev,
  visibleWindow,
} from "../dist/ui/picker.js";

const catalog = {
  live: true,
  entries: [
    { id: "expensive-paid", ownedBy: "", price: { input: 5.0, output: 25.0 }, free: false },
    { id: "free-b", ownedBy: "", price: { input: 0.25, output: 0.85 }, free: true },
    { id: "cheap-paid", ownedBy: "", price: { input: 0.17, output: 0.85 }, free: false },
    { id: "free-a", ownedBy: "", price: { input: 0.5, output: 2.0 }, free: true },
    { id: "no-price-paid", ownedBy: "", price: null, free: false },
    { id: "mid-paid", ownedBy: "", price: { input: 1.7, output: 8.35 }, free: false },
  ],
};

test("groupCatalog: FREE first, PAID sorted cheapest input first, no-price last", () => {
  const groups = groupCatalog(catalog);
  assert.deepEqual(groups.map((g) => g.title), ["FREE", "PAID"]);
  assert.deepEqual(groups[0].entries.map((e) => e.id), ["free-b", "free-a"]);
  assert.deepEqual(groups[1].entries.map((e) => e.id), [
    "cheap-paid",
    "mid-paid",
    "expensive-paid",
    "no-price-paid",
  ]);
});

test("groupCatalog: paid models are shown, never hidden", () => {
  const groups = groupCatalog(catalog);
  assert.equal(groups[1].entries.length, 4);
});

test("groupCatalog: empty catalog yields no groups", () => {
  assert.deepEqual(groupCatalog({ live: false, entries: [] }), []);
});

test("flattenGroups preserves FREE-then-PAID order", () => {
  const flat = flattenGroups(groupCatalog(catalog));
  assert.deepEqual(flat.map((e) => e.id), [
    "free-b",
    "free-a",
    "cheap-paid",
    "mid-paid",
    "expensive-paid",
    "no-price-paid",
  ]);
});

test("pickerNext / pickerPrev wrap around, -1 when empty", () => {
  assert.equal(pickerNext(5, 6), 0);
  assert.equal(pickerNext(0, 6), 1);
  assert.equal(pickerNext(0, 0), -1);
  assert.equal(pickerPrev(0, 6), 5);
  assert.equal(pickerPrev(3, 6), 2);
  assert.equal(pickerPrev(0, 0), -1);
});

test("visibleWindow: selection inside the first page", () => {
  assert.deepEqual(visibleWindow(30, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(visibleWindow(30, 9, 10), { start: 0, end: 10 });
});

test("visibleWindow: selection on a later page moves the window", () => {
  assert.deepEqual(visibleWindow(30, 15, 10), { start: 10, end: 20 });
  assert.deepEqual(visibleWindow(30, 29, 10), { start: 20, end: 30 });
});

test("visibleWindow: window never exceeds the list, small lists fit whole", () => {
  assert.deepEqual(visibleWindow(6, 5, 10), { start: 0, end: 6 });
  assert.deepEqual(visibleWindow(30, 99, 10), { start: 20, end: 30 });
  assert.deepEqual(visibleWindow(0, 0, 10), { start: 0, end: 0 });
  assert.deepEqual(visibleWindow(10, 0, 0), { start: 0, end: 0 });
});

test("isLocked: paid model locks at exactly $0, never on unknown balance", async () => {
  const { isLocked, lockedExplanation } = await import("../dist/ui/picker.js");
  const paid = { id: "pro", ownedBy: "", price: { input: 5, output: 25 }, free: false };
  const free = { id: "glm-5.3-flash", ownedBy: "", price: null, free: true };
  assert.equal(isLocked(paid, 0), true);
  assert.equal(isLocked(paid, 0.0), true);
  assert.equal(isLocked(paid, 0.5), false);
  assert.equal(isLocked(paid, null), false);
  assert.equal(isLocked(free, 0), false);
  assert.ok(lockedExplanation(paid).includes("pro"));
  assert.ok(lockedExplanation(paid).includes("$0.00"));
});

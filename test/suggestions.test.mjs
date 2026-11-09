// Unit tests for the suggestion engine (src/ui/suggestions.ts).
// Port of Freebuff use-suggestion-engine.ts + suggestion-menu.tsx
// (suggestionWindow). Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSlashContext,
  filterSlashCommands,
  fuzzyMatch,
  suggestionWindow,
  suggestionMaxVisible,
} from "../dist/ui/suggestions.js";

const COMMANDS = [
  { id: "model", label: "model", description: "pilih model" },
  { id: "models", label: "models", description: "lihat daftar model" },
  { id: "clear", label: "clear", description: "bersihkan layar chat" },
  { id: "exit", label: "exit", description: "keluar", aliases: ["quit"] },
];

test("parseSlashContext: trigger only on the first line, slash at index 0", () => {
  assert.deepEqual(parseSlashContext("/mod"), { active: true, query: "mod", startIndex: 0 });
  assert.deepEqual(parseSlashContext("/"), { active: true, query: "", startIndex: 0 });
  assert.deepEqual(parseSlashContext(""), { active: false, query: "", startIndex: -1 });
  assert.deepEqual(parseSlashContext("halo /model"), { active: false, query: "", startIndex: -1 });
  assert.deepEqual(parseSlashContext("baris1\n/model"), { active: false, query: "", startIndex: -1 });
  assert.deepEqual(parseSlashContext("/model arg"), { active: false, query: "", startIndex: -1 });
});

test("filterSlashCommands: prefix id, then substring id, then substring desc", () => {
  // Prefix of id first.
  assert.deepEqual(filterSlashCommands(COMMANDS, "mod").map((c) => c.id), ["model", "models"]);
  // Substring of description only (no id contains "ftar").
  assert.deepEqual(filterSlashCommands(COMMANDS, "ftar").map((c) => c.id), ["models"]);
  // Alias counts as id: "quit" matches exit.
  assert.deepEqual(filterSlashCommands(COMMANDS, "quit").map((c) => c.id), ["exit"]);
  // Substring of description only (no id contains "layar").
  assert.deepEqual(filterSlashCommands(COMMANDS, "layar").map((c) => c.id), ["clear"]);
  // Empty query returns everything, in order.
  assert.deepEqual(filterSlashCommands(COMMANDS, "").map((c) => c.id), [
    "model",
    "models",
    "clear",
    "exit",
  ]);
  // No match.
  assert.deepEqual(filterSlashCommands(COMMANDS, "zzz"), []);
});

test("filterSlashCommands: highlight indices point at the matched run", () => {
  const [m] = filterSlashCommands(COMMANDS, "mod");
  assert.deepEqual(m.labelHighlightIndices, [0, 1, 2]);
  const [d] = filterSlashCommands(COMMANDS, "layar");
  assert.ok(d.descriptionHighlightIndices && d.descriptionHighlightIndices.length > 0);
  // Deduped: an item matched by both id and description appears once.
  const both = filterSlashCommands(
    [{ id: "topup", label: "topup", description: "buka halaman top up" }],
    "top",
  );
  assert.equal(both.length, 1);
});

test("fuzzyMatch: in-order chars, score gaps x10 - consecutive x5 - boundary x15 + start", () => {
  // Exact prefix: no gaps, consecutive 3, boundary at 0 -> -15 + 0.
  const exact = fuzzyMatch("model", "mod");
  assert.deepEqual(exact.indices, [0, 1, 2]);
  assert.equal(exact.score, 0 * 10 - 3 * 5 - 1 * 15 + 0);
  // Gapped match scores worse than a tight one.
  const tight = fuzzyMatch("models", "mds");
  const loose = fuzzyMatch("m-x-x-d-x-s", "mds");
  assert.ok(tight && loose && tight.score < loose.score);
  // No match when a char is missing.
  assert.equal(fuzzyMatch("model", "z"), null);
  // Boundary after "/" wins over a later match.
  const boundary = fuzzyMatch("a/model", "m");
  assert.deepEqual(boundary.indices, [2]);
});

test("suggestionWindow: selected item stays in the middle of the window", () => {
  // Freebuff's own formula: start = min(max(0, sel - floor((vis-1)/2)), count - vis).
  assert.deepEqual(suggestionWindow(8, 0, 5), { start: 0, visibleCount: 5 });
  assert.deepEqual(suggestionWindow(8, 4, 5), { start: 2, visibleCount: 5 });
  assert.deepEqual(suggestionWindow(8, 7, 5), { start: 3, visibleCount: 5 });
  assert.deepEqual(suggestionWindow(3, 2, 5), { start: 0, visibleCount: 3 });
  assert.deepEqual(suggestionWindow(0, 0, 5), { start: 0, visibleCount: 0 });
  // Even visible counts center on the lower middle.
  assert.deepEqual(suggestionWindow(20, 10, 10), { start: 6, visibleCount: 10 });
});

test("suggestionMaxVisible: 5 compact, 15 when rows > 35, else 10", () => {
  assert.equal(suggestionMaxVisible(15), 5);
  assert.equal(suggestionMaxVisible(19), 5);
  assert.equal(suggestionMaxVisible(24), 10);
  assert.equal(suggestionMaxVisible(35), 10);
  assert.equal(suggestionMaxVisible(36), 15);
  assert.equal(suggestionMaxVisible(50), 15);
});

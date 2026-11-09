// Unit tests for the command palette logic (src/ui/palette.ts).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS,
  filterCommands,
  paletteNextIndex,
  palettePrevIndex,
  paletteClampIndex,
} from "../dist/ui/palette.js";

test("COMMANDS lists exactly the 12 supported commands (no /agent: Freebuff has no agent toggle — the agent IS the chat)", () => {
  assert.deepEqual(
    COMMANDS.map((c) => c.name),
    ["model", "models", "mode", "init", "compact", "export", "clear", "help", "account", "keys", "topup", "exit"],
  );
});

test("filterCommands: empty query returns the full list", () => {
  assert.equal(filterCommands("").length, 12);
  assert.equal(filterCommands("   ").length, 12);
});

test("filterCommands: no command named /agent (typing it by hand still prints the always-on status)", () => {
  // "agent" still matches /init via its description ("AGENTS.md") —
  // the Freebuff-style filter matches descriptions too. The point is
  // no command named "agent" exists to select.
  assert.ok(!filterCommands("agent").some((c) => c.name === "agent"));
  assert.ok(!COMMANDS.some((c) => c.name === "agent"));
});

test("filterCommands: prefix match", () => {
  assert.deepEqual(filterCommands("mod").map((c) => c.name), ["model", "models", "mode"]);
  assert.deepEqual(filterCommands("c").map((c) => c.name), ["compact", "clear", "account", "init", "export"]);
});

test("filterCommands: substring + case-insensitive", () => {
  assert.deepEqual(filterCommands("MODEL").map((c) => c.name), ["model", "models"]);
  assert.deepEqual(filterCommands("op").map((c) => c.name), ["topup"]);
  assert.deepEqual(filterCommands("top up").map((c) => c.name), ["topup"]);
});

test("filterCommands: no match returns an empty list", () => {
  assert.deepEqual(filterCommands("zzz"), []);
});

test("paletteNextIndex wraps around, -1 when empty", () => {
  assert.equal(paletteNextIndex(0, 8), 1);
  assert.equal(paletteNextIndex(7, 8), 0);
  assert.equal(paletteNextIndex(0, 1), 0);
  assert.equal(paletteNextIndex(0, 0), -1);
});

test("palettePrevIndex wraps around, -1 when empty", () => {
  assert.equal(palettePrevIndex(1, 8), 0);
  assert.equal(palettePrevIndex(0, 8), 7);
  assert.equal(palettePrevIndex(0, 1), 0);
  assert.equal(palettePrevIndex(0, 0), -1);
});

test("paletteClampIndex keeps the selection in range", () => {
  assert.equal(paletteClampIndex(3, 8), 3);
  assert.equal(paletteClampIndex(9, 8), 7);
  assert.equal(paletteClampIndex(-2, 8), 0);
  assert.equal(paletteClampIndex(0, 0), -1);
});

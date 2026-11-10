// Unit tests for the /export message selection (src/agent/slash.ts).
// Regression tests for Bug 1 (2026-11-10): the old `kind === "chat"`
// filter silently dropped the /compact summary (kind "system"), so an
// export after /compact lost all pre-compact context. The summary is
// now flagged `isSummary: true` and selectExportMessages includes it,
// while ordinary system notices stay out.
// Follow-up (2026-11-10): /compact used the same `kind === "chat"`
// filter for its summarization input, so a SECOND /compact lost the
// first summary. selectConversationMessages is now the single
// definition of "conversation content" (chat + summary) shared by
// /export and /compact; the chain tests below simulate compact 1-2-3.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectExportMessages, selectConversationMessages, exportConversation } from "../dist/agent/slash.js";

const chat = (role, content) => ({ role, content, kind: "chat" });
const notice = (content) => ({ role: "assistant", content, kind: "system" });
const summary = (content) => ({ role: "assistant", content, kind: "system", isSummary: true });

test("selectExportMessages: chat messages pass through in order", () => {
  const out = selectExportMessages([
    chat("user", "halo"),
    chat("assistant", "hai"),
    chat("user", "lanjut"),
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai" },
    { role: "user", content: "lanjut" },
  ]);
});

test("selectExportMessages: ordinary system notices are excluded", () => {
  const out = selectExportMessages([
    chat("user", "halo"),
    notice("Mode agen: Default. Mode default."),
    chat("assistant", "hai"),
    notice("Agen berhenti: selesai"),
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai" },
  ]);
});

test("selectExportMessages: the /compact summary is included in chronological position", () => {
  const out = selectExportMessages([
    summary("Ringkasan percakapan:\nKucing makan ikan."),
    chat("user", "cerita burung"),
    chat("assistant", "Balasan setelah compact: burung makan biji."),
  ]);
  assert.deepEqual(out, [
    { role: "assistant", content: "Ringkasan percakapan:\nKucing makan ikan." },
    { role: "user", content: "cerita burung" },
    { role: "assistant", content: "Balasan setelah compact: burung makan biji." },
  ]);
});

test("selectExportMessages: empty input stays empty", () => {
  assert.deepEqual(selectExportMessages([]), []);
});

test("exportConversation: file after /compact contains the summary but not system notices", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metatech-export-test-"));
  try {
    const file = exportConversation({
      cwd: dir,
      model: "glm-5.3-flash",
      mode: "Default",
      messages: selectExportMessages([
        summary("Ringkasan percakapan:\nKucing makan ikan."),
        notice("Mode agen: Default. Mode default."),
        chat("user", "cerita burung"),
        chat("assistant", "Balasan setelah compact: burung makan biji."),
      ]),
    });
    const body = fs.readFileSync(file, "utf-8");
    assert.match(body, /Ringkasan percakapan:/);
    assert.match(body, /Kucing makan ikan\./);
    assert.match(body, /cerita burung/);
    assert.match(body, /Balasan setelah compact: burung makan biji\./);
    assert.doesNotMatch(body, /Mode agen: Default/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- /compact chain: selectConversationMessages (follow-up fix) ---
// compactHistory() replaces the whole display list with ONE summary
// message; the next compact feeds selectConversationMessages(state)
// back into the summarization. These tests simulate that chain.

test("selectConversationMessages: chat + previous summary, notices excluded, order kept", () => {
  const out = selectConversationMessages([
    summary("Ringkasan percakapan:\nKucing makan ikan."),
    notice("Mode agen: Default. Mode default."),
    chat("user", "cerita burung"),
    chat("assistant", "Balasan setelah compact: burung makan biji."),
    notice("Agen berhenti: selesai"),
  ]);
  assert.deepEqual(out, [
    { role: "assistant", content: "Ringkasan percakapan:\nKucing makan ikan." },
    { role: "user", content: "cerita burung" },
    { role: "assistant", content: "Balasan setelah compact: burung makan biji." },
  ]);
});

test("selectConversationMessages: compact chain 1-2-3 keeps the context, no duplication", () => {
  // Compact 1 input: two turns. Its output replaces the state.
  const compact1Input = selectConversationMessages([
    chat("user", "cerita kucing"),
    chat("assistant", "Balasan pertama untuk compact: kucing makan ikan."),
    chat("user", "cerita anjing"),
    chat("assistant", "Balasan kedua untuk compact: anjing makan tulang."),
  ]);
  assert.equal(compact1Input.length, 4);
  // State after compact 1: exactly ONE summary message.
  const stateAfter1 = [summary("Ringkasan percakapan:\nRingkasan: pengguna bertanya tentang kucing dan anjing.")];
  // Compact 2 input: previous summary + one new turn.
  const compact2Input = selectConversationMessages([
    ...stateAfter1,
    chat("user", "cerita burung"),
    chat("assistant", "Balasan setelah compact: burung makan biji."),
  ]);
  assert.deepEqual(compact2Input, [
    { role: "assistant", content: "Ringkasan percakapan:\nRingkasan: pengguna bertanya tentang kucing dan anjing." },
    { role: "user", content: "cerita burung" },
    { role: "assistant", content: "Balasan setelah compact: burung makan biji." },
  ]);
  // State after compact 2: exactly ONE (new) summary — the first
  // summary is subsumed, not kept alongside it.
  const stateAfter2 = [summary("Ringkasan percakapan:\nRingkasan baru: burung makan biji.")];
  assert.equal(stateAfter2.filter((m) => m.isSummary).length, 1);
  // Compact 3 input: second summary + one more turn — chain intact.
  const compact3Input = selectConversationMessages([
    ...stateAfter2,
    chat("user", "cerita ikan"),
    chat("assistant", "Sudah selesai."),
  ]);
  assert.deepEqual(compact3Input, [
    { role: "assistant", content: "Ringkasan percakapan:\nRingkasan baru: burung makan biji." },
    { role: "user", content: "cerita ikan" },
    { role: "assistant", content: "Sudah selesai." },
  ]);
  // No duplication anywhere: each selection holds its summary once.
  assert.equal(compact2Input.filter((m) => m.content.startsWith("Ringkasan percakapan:")).length, 1);
  assert.equal(compact3Input.filter((m) => m.content.startsWith("Ringkasan percakapan:")).length, 1);
});

test("selectConversationMessages: empty input stays empty", () => {
  assert.deepEqual(selectConversationMessages([]), []);
});

test("exportConversation: file after compact 2 contains the latest summary, not the old one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metatech-export-test-"));
  try {
    const file = exportConversation({
      cwd: dir,
      model: "glm-5.3-flash",
      mode: "Default",
      messages: selectExportMessages([
        summary("Ringkasan percakapan:\nRingkasan baru: burung makan biji."),
        notice("Mode agen: Default. Mode default."),
        chat("user", "cerita ikan"),
        chat("assistant", "Sudah selesai."),
      ]),
    });
    const body = fs.readFileSync(file, "utf-8");
    assert.match(body, /Ringkasan baru: burung makan biji\./);
    assert.match(body, /cerita ikan/);
    assert.doesNotMatch(body, /Mode agen: Default/);
    assert.equal((body.match(/Ringkasan percakapan:/g) ?? []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

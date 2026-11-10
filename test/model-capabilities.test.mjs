// Unit tests for the Model Capability Registry (Universal Agent
// Runtime, Fase 2). The registry is the single source of truth for
// what each model has PROVEN it can do: every capability is UNKNOWN
// by default except streaming (a property of the shared SSE
// transport), and nothing is inferred from a model name.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";

import { COMPILED_PRICES, FREE_MODEL_IDS } from "../dist/models.js";
import {
  CAPABILITY_REGISTRY_VERSION,
  PROBE_RESULTS_2026_11_10,
  PROBE_RUN_VERIFIED_AT,
  capabilitiesFor,
  getCapabilityRecord,
  isCapabilityProven,
  listCapabilityRecords,
  mergeCatalogOwnedBy,
  modelsByProvider,
  providersInRegistry,
  providerLabelForModelId,
  setCapability,
  toAvailableModelEntry,
} from "../dist/agent/model-capabilities.js";

const CAPABILITY_FIELDS = [
  "nativeToolCalling",
  "xmlToolCalling",
  "multipleToolCalls",
  "parallelToolCalls",
  "streaming",
  "structuredOutput",
  "reasoning",
  "vision",
];

test("capabilities: registry version is 2", () => {
  assert.equal(CAPABILITY_REGISTRY_VERSION, 2);
});

test("capabilities: seed covers every catalog model", () => {
  const expected = new Set([...Object.keys(COMPILED_PRICES), ...FREE_MODEL_IDS]);
  const records = listCapabilityRecords();
  assert.equal(records.length, expected.size);
  for (const id of expected) {
    assert.ok(records.some((r) => r.modelId === id), `missing seed record: ${id}`);
  }
});

test("capabilities: seed is honest — UNKNOWN everywhere except streaming, plus Fase 9 probe evidence", () => {
  for (const record of listCapabilityRecords()) {
    const probe = PROBE_RESULTS_2026_11_10[record.modelId];
    for (const field of CAPABILITY_FIELDS) {
      if (field === "streaming") {
        assert.equal(record.capabilities.streaming, "SUPPORTED", `${record.modelId}: streaming`);
        assert.equal(record.fieldSources.streaming, "transport", `${record.modelId}: streaming source`);
      } else if (probe && probe.capabilities[field] !== undefined) {
        // Fase 9: a probed field carries the probe's verdict, stamped
        // probe-live. Anything else stays the honest UNKNOWN default.
        assert.equal(record.capabilities[field], probe.capabilities[field], `${record.modelId}: ${field}`);
        assert.equal(record.fieldSources[field], "probe-live", `${record.modelId}: ${field} source`);
      } else {
        assert.equal(record.capabilities[field], "UNKNOWN", `${record.modelId}: ${field}`);
        assert.equal(record.fieldSources[field], "default", `${record.modelId}: ${field} source`);
      }
    }
    assert.equal(record.capabilities.contextWindow, null, `${record.modelId}: contextWindow`);
    if (probe) {
      assert.equal(record.verifiedAt, PROBE_RUN_VERIFIED_AT, `${record.modelId}: verifiedAt`);
      assert.equal(record.notes, probe.notes, `${record.modelId}: notes`);
    } else {
      assert.equal(record.verifiedAt, undefined, `${record.modelId}: never probed`);
    }
  }
});

test("capabilities: no capability is inferred from the model name", () => {
  // A name that SCREAMS tool support must still be UNKNOWN until a
  // live probe proves it. If the seed ever starts trusting names,
  // this test catches it. The model here is deliberately OUTSIDE the
  // Fase 9 probe subset, so its values stay the honest default even
  // after the probe results are seeded.
  const record = getCapabilityRecord("gpt-6.1-terra");
  assert.ok(record);
  assert.equal(record.capabilities.nativeToolCalling, "UNKNOWN");
  assert.equal(record.capabilities.xmlToolCalling, "UNKNOWN");
  assert.equal(record.capabilities.multipleToolCalls, "UNKNOWN");
  assert.equal(record.capabilities.parallelToolCalls, "UNKNOWN");
  assert.equal(record.capabilities.structuredOutput, "UNKNOWN");
  assert.equal(record.capabilities.vision, "UNKNOWN");
});

test("capabilities: unlisted models get an all-UNKNOWN default", () => {
  const record = capabilitiesFor("some-future-model-9.9");
  assert.equal(record.modelId, "some-future-model-9.9");
  for (const field of CAPABILITY_FIELDS) {
    assert.equal(record.capabilities[field], "UNKNOWN", field);
  }
  assert.equal(record.capabilities.contextWindow, null);
  // Even streaming is UNKNOWN for an unlisted model: the registry
  // has not verified the transport fact for it.
  assert.equal(record.capabilities.streaming, "UNKNOWN");
});

test("capabilities: provider labels come from the id family (display only)", () => {
  assert.equal(providerLabelForModelId("claude-sonnet-4-6"), "Anthropic");
  assert.equal(providerLabelForModelId("command-r-08-2024"), "Cohere");
  assert.equal(providerLabelForModelId("deepseek-v4-flash"), "DeepSeek");
  assert.equal(providerLabelForModelId("gemini-3.8-flash"), "Google Gemini");
  assert.equal(providerLabelForModelId("glm-5.3-flash"), "Zhipu");
  assert.equal(providerLabelForModelId("gpt-6-luna"), "OpenAI");
  assert.equal(providerLabelForModelId("qwen3.8-flash"), "Qwen");
  assert.equal(providerLabelForModelId("kimi-k2.7-code"), "Moonshot");
  assert.equal(providerLabelForModelId("grok-4.7"), "xAI");
  assert.equal(providerLabelForModelId("methatech/uncensored"), "MethaTech");
  assert.equal(providerLabelForModelId("whatever-1.0"), "Unknown");
  assert.ok(providersInRegistry().includes("Anthropic"));
  assert.ok(modelsByProvider("Anthropic").every((r) => r.provider === "Anthropic"));
  assert.ok(modelsByProvider("Anthropic").some((r) => r.modelId === "claude-sonnet-4-6"));
});

test("capabilities: setCapability records a probe and stamps verifiedAt", () => {
  // deepseek-v4-pro is outside the Fase 9 probe subset, so its
  // seeded values are still the honest UNKNOWN default here.
  const before = getCapabilityRecord("deepseek-v4-pro");
  assert.equal(before.capabilities.nativeToolCalling, "UNKNOWN");
  assert.equal(before.verifiedAt, undefined);
  const updated = setCapability(
    "deepseek-v4-pro",
    { nativeToolCalling: "SUPPORTED", multipleToolCalls: "SUPPORTED" },
    "probe-live",
    "Fase 9 probe run (test fixture, not a real probe)",
  );
  assert.equal(updated.capabilities.nativeToolCalling, "SUPPORTED");
  assert.equal(updated.capabilities.multipleToolCalls, "SUPPORTED");
  assert.equal(updated.fieldSources.nativeToolCalling, "probe-live");
  assert.equal(updated.fieldSources.multipleToolCalls, "probe-live");
  assert.ok(typeof updated.verifiedAt === "string" && updated.verifiedAt.length > 0);
  // Fields not in the patch are untouched.
  assert.equal(updated.capabilities.parallelToolCalls, "UNKNOWN");
  assert.equal(updated.capabilities.streaming, "SUPPORTED");
  assert.equal(updated.fieldSources.streaming, "transport");
});

test("capabilities: setCapability rejects unknown fields", () => {
  assert.throws(
    () => setCapability("glm-5.3-flash", { supportsMagic: "SUPPORTED" }, "probe-live"),
    /unknown capability field: supportsMagic/,
  );
});

test("capabilities: mergeCatalogOwnedBy overwrites labels from the live catalog", () => {
  const before = getCapabilityRecord("deepseek-v4-pro");
  assert.equal(before.provider, "DeepSeek");
  const updated = mergeCatalogOwnedBy([
    { id: "deepseek-v4-pro", ownedBy: "DeepSeek Official" },
    { id: "not-a-real-model", ownedBy: "Nobody" },
  ]);
  assert.equal(updated, 1);
  assert.equal(getCapabilityRecord("deepseek-v4-pro").provider, "DeepSeek Official");
});

test("capabilities: toAvailableModelEntry serializes the future panel shape", () => {
  // qwen3.7-plus is outside the Fase 9 probe subset: still the
  // honest UNKNOWN default, verified_at null.
  const record = getCapabilityRecord("qwen3.7-plus");
  const entry = toAvailableModelEntry(record);
  assert.equal(entry.id, "qwen3.7-plus");
  assert.equal(entry.owned_by, record.provider);
  assert.equal(entry.capabilities.native_tool_calling, "UNKNOWN");
  assert.equal(entry.capabilities.xml_tool_calling, "UNKNOWN");
  assert.equal(entry.capabilities.streaming, "SUPPORTED");
  assert.equal(entry.capabilities.context_window, null);
  assert.equal(entry.capability_source.streaming, "transport");
  assert.equal(entry.capability_source.native_tool_calling, "default");
  assert.equal(entry.capability_source.xml_tool_calling, "default");
  assert.equal(entry.verified_at, null);
});

test("capabilities: isCapabilityProven only trusts probe-live and transport", () => {
  // gemini-4-argon is outside the Fase 9 probe subset.
  const streaming = getCapabilityRecord("gemini-4-argon");
  assert.equal(isCapabilityProven(streaming, "streaming"), true);
  assert.equal(isCapabilityProven(streaming, "nativeToolCalling"), false);

  // A provider-config SUPPORTED value is not "proven" for routing:
  // only a live probe (or the transport fact) counts.
  const configured = setCapability("gemini-4-argon", { vision: "SUPPORTED" }, "provider-config");
  assert.equal(isCapabilityProven(configured, "vision"), false);

  const probed = setCapability("gemini-4-argon", { vision: "SUPPORTED" }, "probe-live");
  assert.equal(isCapabilityProven(probed, "vision"), true);
});

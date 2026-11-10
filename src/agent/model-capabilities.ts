// Model Capability Registry — Universal Agent Runtime, Fase 2.
//
// This module is the SINGLE SOURCE OF TRUTH for what each model can
// actually do, as far as the CLI knows. It answers the question the
// audit (Fase 1, §11) found NOBODY could answer — not the CLI, not
// the panel, not Freebuff, not MCP: which capabilities has this
// model PROVEN, and which are still unknown?
//
// Rules (Keputusan Reza 2, mengikat):
// - Status per capability: SUPPORTED / UNSUPPORTED / UNKNOWN.
//   UNKNOWN is the honest default. A capability becomes SUPPORTED
//   or UNSUPPORTED only from a live probe (Fase 9) or provider
//   configuration — NEVER from the model name.
// - The registry lives in the CLI first. The panel API is NOT
//   changed in this phase; `toAvailableModelEntry()` serializes a
//   record into the shape a future `/api/available_model`
//   extension could return, so the design is ready for that
//   integration without depending on it.
// - One exception, and it is explicit: `streaming` is SUPPORTED for
//   every catalog model, because streaming is a property of the
//   SHARED transport (one OpenAI-compatible SSE endpoint for all
//   models), not of any individual model — and the audit verified
//   SSE chat working across the catalog. Its source is recorded as
//   "transport" (not "probe-live") so a reader can tell it apart
//   from a per-model probe result. Every other capability is
//   UNKNOWN until the Fase 9 subset probe (10 free + Sonnet + Opus
//   + 1 per other provider) proves it per model.
//
// - `provider` is a DISPLAY label only. It comes from the model-id
//   family prefix at seed time ("claude-*" → Anthropic) and is
//   overwritten by the panel catalog's `owned_by` via
//   `mergeCatalogOwnedBy()` when the live catalog is available.
//   It is NOT routing info (the panel routes by channel) and NOT a
//   capability inference — grouping models by provider is for
//   display and probe planning only.
//
// - `contextWindow` is null until a probe or provider config sets
//   it. A null window means "unknown", never "unlimited".
//
// The registry is in-memory and mutable through `setCapability()`
// (the Fase 9 probe writes through it). It is NOT persisted to disk
// in this phase — probe results are recorded in the Fase 9 report
// and re-seeded from the audit doc until persistence is decided
// (Fase 9/10).

import { COMPILED_PRICES, FREE_MODEL_IDS } from "../models.js";

/** Registry format version. Bump when a field is added/renamed so
 *  later phases can detect a stale registry. */
export const CAPABILITY_REGISTRY_VERSION = 2;

/** Capability status (Keputusan Reza 2). UNKNOWN is the default;
 *  SUPPORTED/UNSUPPORTED come only from a live probe or provider
 *  configuration. */
export type CapabilityStatus = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

/** Per-model capabilities. Every field is a status except
 *  `contextWindow`, which is a token count or null (unknown). */
export interface ModelCapabilities {
  /** The model returns structured `tool_calls` when `tools` are sent. */
  nativeToolCalling: CapabilityStatus;
  /** The model emits a valid XML tool-call tag (the CLI's actual
   *  tool-call channel) when instructed. Added Fase 9: the XML
   *  fallback is a per-model behavior that must be recorded, not
   *  assumed from native support. */
  xmlToolCalling: CapabilityStatus;
  /** The model returns more than one tool call in a single turn. */
  multipleToolCalls: CapabilityStatus;
  /** The model returns parallel (independent) tool calls. */
  parallelToolCalls: CapabilityStatus;
  /** The model streams SSE deltas (transport-level, see header). */
  streaming: CapabilityStatus;
  /** The model honors a structured-output / JSON mode request. */
  structuredOutput: CapabilityStatus;
  /** The model emits reasoning/thinking deltas. */
  reasoning: CapabilityStatus;
  /** The model accepts image input. */
  vision: CapabilityStatus;
  /** Max context window in tokens, when known. null = unknown. */
  contextWindow: number | null;
}

/** Where a capability value came from. Recorded per field, so a
 *  reader can tell a transport fact from a probe fact from a
 *  default. */
export type CapabilitySource =
  | "probe-live" // Fase 9 live probe against the panel
  | "provider-config" // provider documentation / channel config
  | "transport" // shared SSE transport (streaming only)
  | "default"; // the honest UNKNOWN default

export type CapabilityField = keyof ModelCapabilities;

/** One model's capability record. */
export interface CapabilityRecord {
  modelId: string;
  /** Display label only (see header). Overwritten by the live
   *  catalog's owned_by via mergeCatalogOwnedBy(). */
  provider: string;
  capabilities: ModelCapabilities;
  /** Per-field provenance. */
  fieldSources: Record<CapabilityField, CapabilitySource>;
  /** ISO timestamp of the last live probe that set any field.
   *  Undefined when nothing has ever been probed. */
  verifiedAt?: string;
  /** Human note, e.g. which probe run or config produced a value. */
  notes?: string;
}

const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  nativeToolCalling: "UNKNOWN",
  xmlToolCalling: "UNKNOWN",
  multipleToolCalls: "UNKNOWN",
  parallelToolCalls: "UNKNOWN",
  streaming: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  reasoning: "UNKNOWN",
  vision: "UNKNOWN",
  contextWindow: null,
};

const DEFAULT_FIELD_SOURCES: Record<CapabilityField, CapabilitySource> = {
  nativeToolCalling: "default",
  xmlToolCalling: "default",
  multipleToolCalls: "default",
  parallelToolCalls: "default",
  streaming: "default",
  structuredOutput: "default",
  reasoning: "default",
  vision: "default",
  contextWindow: "default",
};

/**
 * Provider display label from the model-id family prefix. This is a
 * LABEL, not routing info and not a capability inference: the panel
 * decides routing by channel, and the authoritative label is the
 * catalog's `owned_by` (mergeCatalogOwnedBy). Families are the ones
 * in the live catalog (COMPILED_PRICES, taken from
 * /api/available_model 2026-11-08).
 */
export function providerLabelForModelId(modelId: string): string {
  if (modelId.startsWith("claude-")) return "Anthropic";
  if (modelId.startsWith("command-")) return "Cohere";
  if (modelId.startsWith("deepseek-")) return "DeepSeek";
  if (modelId.startsWith("gemini-")) return "Google Gemini";
  if (modelId.startsWith("glm-")) return "Zhipu";
  if (modelId.startsWith("gpt-")) return "OpenAI";
  if (modelId.startsWith("qwen")) return "Qwen";
  if (modelId.startsWith("kimi-")) return "Moonshot";
  if (modelId.startsWith("grok-")) return "xAI";
  if (modelId.startsWith("methatech/")) return "MethaTech";
  return "Unknown";
}

/**
 * Fase 9 live-probe results (2026-11-10, test account id10, panel
 * relay). Each entry is EVIDENCE from the probe run — a model
 * appears here only if it was actually probed; unprobed models stay
 * UNKNOWN. The table is applied at seed time (see seedRecord), so a
 * fresh import already carries the proven values. Full per-probe
 * detail (prompts, outcomes, errors) lives in
 * docs/UNIVERSAL-RUNTIME-PHASE9.md, not in this table.
 *
 * Status rules used by the probe:
 *   nativeToolCalling SUPPORTED = the model returned >= 1 complete
 *     native tool_call for the probe's two functions.
 *   multipleToolCalls SUPPORTED = >= 2 calls in one response.
 *   parallelToolCalls SUPPORTED = >= 2 calls in one response (the
 *     probe's two functions are independent, so two calls in one
 *     response are parallel by construction).
 *   xmlToolCalling SUPPORTED = the model returned exactly one valid
 *     XML tag with valid JSON params for a registered tool.
 *   structuredOutput SUPPORTED = the model returned a valid JSON
 *     object under response_format json_object.
 *   reasoning SUPPORTED = reasoning_content deltas observed in any
 *     probe response. Absence is UNKNOWN, not UNSUPPORTED: a short
 *     reply that needed no reasoning proves nothing.
 *   UNSUPPORTED = the model was probed and did the opposite (e.g.
 *     native: answered in plain text with no tool_calls; XML:
 *     answered in plain text or emitted a malformed tag; JSON mode:
 *     returned non-JSON text). A transport/panel error is NOT a
 *     capability verdict — the field stays UNKNOWN and the reason
 *     is recorded in the notes.
 */
export const PROBE_RUN_VERIFIED_AT = "2026-11-10T08:25:00Z";

export const PROBE_RESULTS_2026_11_10: Record<
  string,
  { capabilities: Partial<Omit<ModelCapabilities, "contextWindow">>; notes: string }
> = {
  // Free models: native NOT TESTED in either pass — the panel
  // returned 503 "Current group upstream is saturated" for every
  // tools request (2 attempts per pass), while plain requests on
  // the same model succeeded seconds later. That is a panel /
  // upstream failure, not a model verdict: native stays UNKNOWN.
  "deepseek-v4-flash": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2; native NOT TESTED — panel 503 for every tools request.",
  },
  "glm-5.3-flash": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED", reasoning: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2, reasoning deltas observed; native NOT TESTED — panel 503 for every tools request.",
  },
  "gpt-6-luna": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2 (pass 1 wrapped it in a one-off <escape> tag, parser still extracted it), JSON mode valid 2/2; native NOT TESTED — panel 503 for every tools request.",
  },
  "gemini-3.8-flash": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED", reasoning: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid in pass 2 (pass 1 answered with a plain greeting, no tag — first-ask compliance is inconsistent, the loop nudge exists for exactly this), JSON mode valid 2/2, reasoning deltas observed in pass 2; native NOT TESTED — panel 503 for every tools request.",
  },
  "gpt-6-astra": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2 (leading space before the tag both times, harmless), JSON mode valid 2/2; native NOT TESTED — panel 503 for every tools request.",
  },
  "gemini-3.1-pro": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED", reasoning: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid in pass 2 (pass 1 answered with a plain greeting, no tag — first-ask compliance is inconsistent, the loop nudge exists for exactly this), JSON mode valid 2/2, reasoning deltas observed in pass 2; native NOT TESTED — panel 503 for every tools request.",
  },
  "qwen3.8-flash": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED", reasoning: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2, reasoning deltas observed in both passes; native NOT TESTED — panel 503 for every tools request.",
  },
  "qwen3.7-max": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED", reasoning: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2, reasoning deltas observed in both passes; native NOT TESTED — panel 503 for every tools request.",
  },
  "deepseek-v4.1-flash": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2; native NOT TESTED — panel 503 for every tools request.",
  },
  // Cohere is the ONE model whose native probe answered: 2 native
  // tool calls (read_files + list_directory) in a single response,
  // finish_reason tool_calls. That also proves the panel's tools
  // path itself works — the 503s above are per-channel saturation,
  // not a blanket rejection of tools.
  "command-r-plus-08-2024": {
    capabilities: {
      nativeToolCalling: "SUPPORTED",
      multipleToolCalls: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      xmlToolCalling: "SUPPORTED",
      structuredOutput: "SUPPORTED",
    },
    notes: "Fase 9 probe 2026-11-10 (pass 1 only — fully proven, not re-run in pass 2): native 2 tool calls in one response (finish tool_calls), XML tag valid, JSON mode valid.",
  },
  "grok-4.7": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2; native NOT TESTED — panel 503 for every tools request. Panel usage counts for this model look inflated vs the actual text (observation, not a verdict).",
  },
  "kimi-k3.1-pro": {
    capabilities: { xmlToolCalling: "SUPPORTED", structuredOutput: "SUPPORTED" },
    notes: "Fase 9 probe 2026-11-10 (2 passes): XML tag valid 2/2, JSON mode valid 2/2; native NOT TESTED — panel 503 for every tools request.",
  },
  // NOT in this table (stay UNKNOWN): claude-sonnet-4-6,
  // claude-opus-4-6-thinking, methatech/uncensored — every probe
  // (native, XML, structured) returned 503 in BOTH passes
  // (VectorHead channel saturated). No capability was proven or
  // disproven for them; see docs/UNIVERSAL-RUNTIME-PHASE9.md.
};

function seedRecord(modelId: string): CapabilityRecord {
  const record: CapabilityRecord = {
    modelId,
    provider: providerLabelForModelId(modelId),
    capabilities: {
      ...UNKNOWN_CAPABILITIES,
      // Transport-level fact (see header): every catalog model is
      // served through the same OpenAI-compatible SSE endpoint.
      streaming: "SUPPORTED",
    },
    fieldSources: { ...DEFAULT_FIELD_SOURCES, streaming: "transport" },
    notes: "Seeded Fase 2: all capabilities UNKNOWN except streaming (shared SSE transport).",
  };
  // Fase 9: apply the live-probe evidence for this model, if any.
  // Probe values overwrite the UNKNOWN default (never the transport
  // streaming fact) and are stamped probe-live with the run time.
  const probe = PROBE_RESULTS_2026_11_10[modelId];
  if (probe) {
    for (const [field, value] of Object.entries(probe.capabilities) as [Exclude<CapabilityField, "contextWindow">, CapabilityStatus][]) {
      if (field === "streaming") continue;
      record.capabilities[field] = value;
      record.fieldSources[field] = "probe-live";
    }
    record.verifiedAt = PROBE_RUN_VERIFIED_AT;
    record.notes = probe.notes;
  }
  return record;
}

function buildSeed(): Map<string, CapabilityRecord> {
  const ids = new Set<string>([...Object.keys(COMPILED_PRICES), ...FREE_MODEL_IDS]);
  const map = new Map<string, CapabilityRecord>();
  for (const id of [...ids].sort()) map.set(id, seedRecord(id));
  return map;
}

/** The registry. Seeded once from the catalog; mutated only through
 *  setCapability() / mergeCatalogOwnedBy() (probe writes). */
const registry: Map<string, CapabilityRecord> = buildSeed();

/** All records, sorted by model id. Returns copies — mutate
 *  through setCapability(), never by editing the returned objects. */
export function listCapabilityRecords(): CapabilityRecord[] {
  return [...registry.values()].map((r) => ({
    ...r,
    capabilities: { ...r.capabilities },
    fieldSources: { ...r.fieldSources },
  }));
}

/** One record by model id, or undefined when the model is not in
 *  the seeded catalog. */
export function getCapabilityRecord(modelId: string): CapabilityRecord | undefined {
  const r = registry.get(modelId);
  if (!r) return undefined;
  return { ...r, capabilities: { ...r.capabilities }, fieldSources: { ...r.fieldSources } };
}

/**
 * Capabilities for any model id — seeded record when known, else a
 * fresh all-UNKNOWN default (streaming included: an unlisted model
 * has not proven even the transport fact to this registry). The
 * loop must never crash on a model the catalog does not list.
 */
export function capabilitiesFor(modelId: string): CapabilityRecord {
  const known = registry.get(modelId);
  if (known) {
    return { ...known, capabilities: { ...known.capabilities }, fieldSources: { ...known.fieldSources } };
  }
  return {
    modelId,
    provider: providerLabelForModelId(modelId),
    capabilities: { ...UNKNOWN_CAPABILITIES },
    fieldSources: { ...DEFAULT_FIELD_SOURCES },
    notes: "Unlisted model: all capabilities UNKNOWN (not in the seeded catalog).",
  };
}

/**
 * Record probe / provider-config results for a model. Only the
 * fields in `patch` change; each patched field's source is set to
 * `source` and `verifiedAt` is stamped (probe-live only). Unknown
 * capability keys throw — a probe must not silently invent fields.
 * Returns the updated record.
 */
export function setCapability(
  modelId: string,
  patch: Partial<ModelCapabilities>,
  source: "probe-live" | "provider-config",
  notes?: string,
): CapabilityRecord {
  const validKeys = new Set(Object.keys(UNKNOWN_CAPABILITIES));
  for (const key of Object.keys(patch)) {
    if (!validKeys.has(key)) throw new Error(`capability registry: unknown capability field: ${key}`);
  }
  let record = registry.get(modelId);
  if (!record) {
    record = seedRecord(modelId);
    registry.set(modelId, record);
  }
  for (const [key, value] of Object.entries(patch)) {
    const field = key as CapabilityField;
    (record.capabilities as unknown as Record<string, unknown>)[field] = value;
    record.fieldSources[field] = source;
  }
  if (source === "probe-live") record.verifiedAt = new Date().toISOString();
  if (notes !== undefined) record.notes = notes;
  return getCapabilityRecord(modelId) as CapabilityRecord;
}

/** Records grouped by provider label, for display / probe planning. */
export function modelsByProvider(provider: string): CapabilityRecord[] {
  return listCapabilityRecords().filter((r) => r.provider === provider);
}

/** Provider labels present in the registry. */
export function providersInRegistry(): string[] {
  return [...new Set(listCapabilityRecords().map((r) => r.provider))].sort();
}

/**
 * Overwrite provider display labels from the live panel catalog
 * (`/api/available_model` owned_by — the authoritative label).
 * Returns the number of records updated. Unlisted catalog ids are
 * ignored (the registry seed is the catalog snapshot; new models
 * arrive through a re-seed, not a silent insert).
 */
export function mergeCatalogOwnedBy(entries: { id: string; ownedBy: string }[]): number {
  let updated = 0;
  for (const e of entries) {
    const record = registry.get(e.id);
    if (!record) continue;
    if (typeof e.ownedBy === "string" && e.ownedBy.length > 0 && record.provider !== e.ownedBy) {
      record.provider = e.ownedBy;
      updated += 1;
    }
  }
  return updated;
}

/**
 * True only when a capability is SUPPORTED *and* the value came
 * from a live probe (or, for streaming, from the transport fact).
 * This is the predicate a later phase's routing reads: a SUPPORTED value
 * with source "default" can never exist (the seed only supports
 * streaming via "transport"), so a stale or assumed value cannot
 * route a model down the native path.
 */
export function isCapabilityProven(record: CapabilityRecord, field: CapabilityField): boolean {
  if (record.capabilities[field] !== "SUPPORTED") return false;
  const source = record.fieldSources[field];
  return source === "probe-live" || source === "transport";
}

// ---------------------------------------------------------------------------
// Serialization for a future /api/available_model integration
// ---------------------------------------------------------------------------

/** The shape a future panel `/api/available_model` extension could
 *  return per model (snake_case, panel style). Design only in Fase
 *  2 — the panel is NOT changed, and nothing reads this shape yet.
 *  The point is that the CLI registry and a future server field
 *  already agree on keys, statuses, and provenance, so integration
 *  later is a merge, not a redesign. */
export interface AvailableModelCapabilityEntry {
  id: string;
  owned_by: string;
  capabilities: {
    native_tool_calling: CapabilityStatus;
    xml_tool_calling: CapabilityStatus;
    multiple_tool_calls: CapabilityStatus;
    parallel_tool_calls: CapabilityStatus;
    streaming: CapabilityStatus;
    structured_output: CapabilityStatus;
    reasoning: CapabilityStatus;
    vision: CapabilityStatus;
    context_window: number | null;
  };
  capability_source: Record<string, CapabilitySource>;
  verified_at: string | null;
}

export function toAvailableModelEntry(record: CapabilityRecord): AvailableModelCapabilityEntry {
  const c = record.capabilities;
  const s = record.fieldSources;
  return {
    id: record.modelId,
    owned_by: record.provider,
    capabilities: {
      native_tool_calling: c.nativeToolCalling,
      xml_tool_calling: c.xmlToolCalling,
      multiple_tool_calls: c.multipleToolCalls,
      parallel_tool_calls: c.parallelToolCalls,
      streaming: c.streaming,
      structured_output: c.structuredOutput,
      reasoning: c.reasoning,
      vision: c.vision,
      context_window: c.contextWindow,
    },
    // Provenance uses the same snake_case keys as the capabilities
    // object, so a server consumer reads one key style.
    capability_source: {
      native_tool_calling: s.nativeToolCalling,
      xml_tool_calling: s.xmlToolCalling,
      multiple_tool_calls: s.multipleToolCalls,
      parallel_tool_calls: s.parallelToolCalls,
      streaming: s.streaming,
      structured_output: s.structuredOutput,
      reasoning: s.reasoning,
      vision: s.vision,
      context_window: s.contextWindow,
    },
    verified_at: record.verifiedAt ?? null,
  };
}

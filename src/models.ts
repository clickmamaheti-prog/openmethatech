import { consoleBase } from "./config.js";

// The 10 FREE models. Same set as the panel's free allowlist.
export const FREE_MODEL_IDS: readonly string[] = [
  "deepseek-v4-flash",
  "glm-5.3-flash",
  "gpt-6-luna",
  "gemini-3.8-flash",
  "gpt-6-astra",
  "gemini-3.1-pro",
  "qwen3.8-flash",
  "qwen3.7-max",
  "kimi-k2.7-code",
  "deepseek-v4.1-flash",
] as const;

export const DEFAULT_MODEL = "glm-5.3-flash";
export const FALLBACK_MODEL = "deepseek-v4-flash";

export interface ModelPrice {
  /** dollars per 1M input tokens */
  input: number;
  /** dollars per 1M output tokens */
  output: number;
}

// Compiled-in fallback, taken from the live /api/available_model on
// 2026-11-08. Live price = ratio * 2 ($1 = 500,000 quota). The CLI prefers
// the live fetch; this table is only used when the server cannot be reached.
export const COMPILED_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-6-thinking": { input: 8.35, output: 41.6 },
  "claude-sonnet-4-6": { input: 5.0, output: 25.0 },
  "command-a-03-2025": { input: 4.2, output: 16.65 },
  "command-r-08-2024": { input: 0.25, output: 1.0 },
  "command-r-plus-08-2024": { input: 4.2, output: 16.65 },
  "command-r7b-12-2024": { input: 0.065, output: 0.25 },
  "deepseek-v4-flash": { input: 0.5, output: 2.0 },
  "deepseek-v4-pro": { input: 2.2, output: 6.6 },
  "deepseek-v4.1-flash": { input: 0.5, output: 2.0 },
  "gemini-3.1-pro": { input: 3.35, output: 20.0 },
  "gemini-3.8-flash": { input: 2.5, output: 12.5 },
  "gemini-4-argon": { input: 6.7, output: 33.3 },
  "glm-5.2": { input: 2.35, output: 7.35 },
  "glm-5.3": { input: 2.35, output: 7.35 },
  "glm-5.3-flash": { input: 0.25, output: 0.85 },
  "gpt-6-astra": { input: 17.0, output: 83.2 },
  "gpt-6-luna": { input: 0.17, output: 0.85 },
  "gpt-6.1-sol": { input: 3.35, output: 16.65 },
  "gpt-6.1-terra": { input: 1.7, output: 8.35 },
  "gpt-oss-120b-medium": { input: 0.25, output: 1.0 },
  "grok-4.7": { input: 3.35, output: 10.0 },
  "kimi-k3.1-pro": { input: 3.35, output: 16.65 },
  "methatech/uncensored": { input: 0.2, output: 0.6 },
  "qwen3.6-plus": { input: 0.85, output: 5.0 },
  "qwen3.7-max": { input: 4.2, output: 12.5 },
  "qwen3.7-plus": { input: 0.7, output: 2.7 },
  "qwen3.8-flash": { input: 0.25, output: 0.8 },
};

export interface CatalogEntry {
  id: string;
  ownedBy: string;
  price: ModelPrice | null;
  free: boolean;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** true when the live server answered, false when using the compiled table */
  live: boolean;
}

function buildCatalog(prices: Record<string, ModelPrice>): Catalog {
  const ids = new Set([...Object.keys(prices), ...FREE_MODEL_IDS]);
  const entries: CatalogEntry[] = [...ids].map((id) => ({
    id,
    ownedBy: "",
    price: prices[id] ?? null,
    free: (FREE_MODEL_IDS as readonly string[]).includes(id),
  }));
  // FREE first, then cheapest input price first (Freebuff pattern).
  entries.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    const pa = a.price?.input ?? Number.POSITIVE_INFINITY;
    const pb = b.price?.input ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  return { entries, live: false };
}

/** Fetch the live price table from the console. Falls back to the compiled table. */
export async function fetchCatalog(): Promise<Catalog> {
  try {
    const res = await fetch(`${consoleBase()}/api/available_model`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return buildCatalog(COMPILED_PRICES);
    const json = (await res.json()) as {
      data?: Record<string, { owned_by?: string; price?: { input?: number; output?: number } }>;
    };
    const data = json.data ?? {};
    const prices: Record<string, ModelPrice> = {};
    const ownedBy: Record<string, string> = {};
    for (const [id, m] of Object.entries(data)) {
      if (typeof m.price?.input === "number" && typeof m.price?.output === "number") {
        prices[id] = { input: m.price.input * 2, output: m.price.output * 2 };
      }
      if (typeof m.owned_by === "string") ownedBy[id] = m.owned_by;
    }
    if (Object.keys(prices).length === 0) return buildCatalog(COMPILED_PRICES);
    const catalog = buildCatalog(prices);
    catalog.live = true;
    for (const e of catalog.entries) e.ownedBy = ownedBy[e.id] ?? "";
    return catalog;
  } catch {
    return buildCatalog(COMPILED_PRICES);
  }
}

export function priceFor(catalog: Catalog, modelId: string): ModelPrice | null {
  return catalog.entries.find((e) => e.id === modelId)?.price ?? COMPILED_PRICES[modelId] ?? null;
}

export function isFreeModel(modelId: string): boolean {
  return (FREE_MODEL_IDS as readonly string[]).includes(modelId);
}

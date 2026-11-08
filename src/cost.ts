import type { ModelPrice } from "./models.js";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Dollar cost of one answer at the model's per-1M-token rates. */
export function costOf(usage: Usage, price: ModelPrice | null): number | null {
  if (!price) return null;
  return (usage.promptTokens / 1_000_000) * price.input + (usage.completionTokens / 1_000_000) * price.output;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatUsageLine(usage: Usage, price: ModelPrice | null): string {
  const cost = costOf(usage, price);
  const costText = cost === null ? "cost —" : formatUsd(cost);
  return `${usage.promptTokens} in / ${usage.completionTokens} out · ${costText}`;
}

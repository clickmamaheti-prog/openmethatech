// Command palette logic — pure, no Ink/React. Unit-testable in isolation.
// The component (CommandPalette.tsx) only renders what these functions
// return; all filtering and navigation lives here.
//
// Filtering is Freebuff's priority slash filter (use-suggestion-engine.ts
// filterSlashCommands, via suggestions.ts): prefix of name/alias, then
// substring of name/alias, then substring of description — deduped, in
// that order. Empty query returns the full list.

import { filterSlashCommands, type SuggestionItem } from "./suggestions.js";

export interface PaletteCommand {
  name: string;
  desc: string;
  aliases?: string[];
}

export const COMMANDS: readonly PaletteCommand[] = [
  { name: "model", desc: "pilih model (atau /model <id> langsung)" },
  { name: "models", desc: "lihat daftar model" },
  { name: "agent", desc: "nyalakan/matikan agen koding" },
  { name: "mode", desc: "ganti mode agen (build/lite/max/plan)" },
  { name: "init", desc: "baca codebase, buat AGENTS.md" },
  { name: "compact", desc: "ringkas percakapan" },
  { name: "export", desc: "ekspor percakapan ke file Markdown" },
  { name: "clear", desc: "bersihkan layar chat" },
  { name: "help", desc: "bantuan" },
  { name: "account", desc: "ringkasan akun" },
  { name: "keys", desc: "info API key" },
  { name: "topup", desc: "buka halaman top up" },
  { name: "exit", desc: "keluar", aliases: ["quit"] },
];

function toSuggestionItems(): SuggestionItem[] {
  return COMMANDS.map((c) => ({
    id: c.name,
    label: c.name,
    description: c.desc,
    aliases: c.aliases,
  }));
}

/**
 * Filter commands in real time as the user types after "/".
 * Priority: prefix of name/alias → substring of name/alias →
 * substring of description. Empty query returns the full list.
 */
export function filterCommands(query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...COMMANDS];
  return filterSlashCommands(toSuggestionItems(), q).map((s) => {
    const cmd = COMMANDS.find((c) => c.name === s.id) as PaletteCommand;
    return cmd;
  });
}

/** Next selection, wrapping around. Returns -1 when the list is empty. */
export function paletteNextIndex(current: number, total: number): number {
  if (total <= 0) return -1;
  return (current + 1) % total;
}

/** Previous selection, wrapping around. Returns -1 when the list is empty. */
export function palettePrevIndex(current: number, total: number): number {
  if (total <= 0) return -1;
  return (current - 1 + total) % total;
}

/** Clamp a selection into range (used when the filter shrinks the list). */
export function paletteClampIndex(current: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return 0;
  if (current >= total) return total - 1;
  return current;
}

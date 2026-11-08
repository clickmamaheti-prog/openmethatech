// Command palette logic — pure, no Ink/React. Unit-testable in isolation.
// The component (CommandPalette.tsx) only renders what these functions
// return; all filtering and navigation lives here.

export interface PaletteCommand {
  name: string;
  desc: string;
}

export const COMMANDS: readonly PaletteCommand[] = [
  { name: "model", desc: "pilih model (atau /model <id> langsung)" },
  { name: "models", desc: "lihat daftar model" },
  { name: "clear", desc: "bersihkan layar chat" },
  { name: "help", desc: "bantuan" },
  { name: "account", desc: "ringkasan akun" },
  { name: "keys", desc: "info API key" },
  { name: "topup", desc: "buka halaman top up" },
  { name: "exit", desc: "keluar" },
];

/**
 * Filter commands in real time as the user types after "/".
 * Prefix and substring matches, case-insensitive, over name and desc.
 * Empty query returns the full list.
 */
export function filterCommands(query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...COMMANDS];
  return COMMANDS.filter(
    (c) => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
  );
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

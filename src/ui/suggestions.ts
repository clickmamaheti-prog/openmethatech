// Suggestion engine — pure, no Ink/React. Unit-testable.
//
// Port of the PATTERN in Freebuff `cli/src/hooks/use-suggestion-engine.ts`
// (766 lines) + `cli/src/components/suggestion-menu.tsx`
// (suggestionWindow), commit 5d8bd24, Apache-2.0. Only the slash-command
// half is ported: MethaTech has no @mention agents and no file tree, so
// the mention/file branches are not carried over. The fuzzy matcher is
// ported verbatim in scoring (gap x10, consecutive x5, boundary x15,
// early-start bonus) and is used for file-style matching; slash commands
// use the priority filter below, exactly like Freebuff's
// filterSlashCommands.

export interface SuggestionItem {
  id: string;
  label: string;
  description: string;
  aliases?: string[];
  labelHighlightIndices?: number[];
  descriptionHighlightIndices?: number[];
}

/** Build [start, end) highlight runs from a match position. */
export function highlightIndices(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/**
 * Slash trigger detection (use-suggestion-engine.ts parseSlashContext):
 * the trigger is a "/" on the FIRST line only, matching
 * /^(\s*)\/([^\s]*)$/, and the slash must start at index 0.
 * Anything after the first line, or a "/" mid-line, is not a trigger.
 */
export function parseSlashContext(input: string): {
  active: boolean;
  query: string;
  startIndex: number;
} {
  const firstLine = input.split("\n")[0] ?? "";
  const match = firstLine.match(/^(\s*)\/([^\s]*)$/);
  if (!match) return { active: false, query: "", startIndex: -1 };
  const startIndex = (match[1] ?? "").length;
  // Slash commands only activate on the first line (startIndex must be 0).
  if (startIndex !== 0) return { active: false, query: "", startIndex: -1 };
  return { active: true, query: match[2] ?? "", startIndex };
}

/**
 * Priority slash filter (filterSlashCommands): three passes, each
 * deduped with a Set so an item appears once, in the best pass that
 * matched it:
 *   1. prefix of id (or alias)
 *   2. substring of id (or alias)
 *   3. substring of description
 * Highlight indices point at the matched run in the label/description.
 * Empty query returns the full list, in definition order.
 */
export function filterSlashCommands(
  commands: SuggestionItem[],
  query: string,
): SuggestionItem[] {
  if (!query) return [...commands];
  const normalized = query.toLowerCase();
  const matches: SuggestionItem[] = [];
  const seen = new Set<string>();
  const pushUnique = (item: SuggestionItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    matches.push(item);
  };
  const matchByIdOrAlias = (test: (haystack: string, needle: string) => boolean) => {
    for (const command of commands) {
      if (seen.has(command.id)) continue;
      const id = command.id.toLowerCase();
      const aliases = (command.aliases ?? []).map((a) => a.toLowerCase());
      if (test(id, normalized) || aliases.some((a) => test(a, normalized))) {
        const label = command.label.toLowerCase();
        const firstIndex = label.indexOf(normalized);
        pushUnique({
          ...command,
          ...(firstIndex !== -1
            ? { labelHighlightIndices: highlightIndices(firstIndex, firstIndex + normalized.length) }
            : {}),
        });
      }
    }
  };
  // Prefix of ID.
  matchByIdOrAlias((haystack, needle) => haystack.startsWith(needle));
  // Substring of ID.
  matchByIdOrAlias((haystack, needle) => haystack.includes(needle));
  // Substring of description.
  for (const command of commands) {
    if (seen.has(command.id)) continue;
    const description = command.description.toLowerCase();
    if (description.includes(normalized)) {
      const firstIndex = description.indexOf(normalized);
      pushUnique({
        ...command,
        ...(firstIndex !== -1
          ? {
              descriptionHighlightIndices: highlightIndices(
                firstIndex,
                firstIndex + normalized.length,
              ),
            }
          : {}),
      });
    }
  }
  return matches;
}

/**
 * Fuzzy match (use-suggestion-engine.ts fuzzyMatch): characters in
 * order, gaps allowed. Score (lower is better):
 *   gaps x 10 - maxConsecutive x 5 - boundaryBonus x 15 + firstIndex
 * where a boundary is index 0 or the previous char is "/".
 * Returns highlight indices + score, or null when no match.
 */
export function fuzzyMatch(
  text: string,
  query: string,
): { indices: number[]; score: number } | null {
  const textLower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const indices: number[] = [];
  let textIdx = 0;
  let lastMatchIdx = -1;
  let gaps = 0;
  let consecutiveMatches = 0;
  let maxConsecutive = 0;

  for (let queryIdx = 0; queryIdx < queryLower.length; queryIdx++) {
    const char = queryLower[queryIdx] as string;
    let found = false;
    while (textIdx < textLower.length) {
      if (textLower[textIdx] === char) {
        if (lastMatchIdx >= 0 && textIdx > lastMatchIdx + 1) {
          gaps += textIdx - lastMatchIdx - 1;
          consecutiveMatches = 1;
        } else {
          consecutiveMatches++;
          maxConsecutive = Math.max(maxConsecutive, consecutiveMatches);
        }
        indices.push(textIdx);
        lastMatchIdx = textIdx;
        textIdx++;
        found = true;
        break;
      }
      textIdx++;
    }
    if (!found) return null;
  }

  maxConsecutive = Math.max(maxConsecutive, consecutiveMatches);
  const boundaryBonus = indices.filter(
    (idx) => idx === 0 || text[idx - 1] === "/",
  ).length;
  const score =
    gaps * 10 - maxConsecutive * 5 - boundaryBonus * 15 + (indices[0] ?? 0);
  return { indices, score };
}

/**
 * Centered suggestion window (suggestion-menu.tsx suggestionWindow):
 * the selected item is kept in the middle of the visible window.
 *   start = min(max(0, selected - floor((visible-1)/2)), count - visible)
 */
export function suggestionWindow(
  count: number,
  selectedIndex: number,
  maxVisible: number,
): { start: number; visibleCount: number } {
  if (count <= 0) return { start: 0, visibleCount: 0 };
  const selected = Math.max(0, Math.min(selectedIndex, count - 1));
  const visibleCount = Math.min(Math.max(maxVisible, 1), count);
  const start = Math.max(
    0,
    Math.min(selected - Math.floor((visibleCount - 1) / 2), count - visibleCount),
  );
  return { start, visibleCount };
}

/**
 * How many suggestion rows fit (chat.tsx:1287, chat-input-bar.tsx:193):
 * 5 when the terminal is compact, 15 when rows > 35, else 10.
 * Compact here means rows < 20 (the same height breakpoint as
 * layout.ts: height xs).
 */
export function suggestionMaxVisible(rows: number): number {
  if (rows < 20) return 5;
  if (rows > 35) return 15;
  return 10;
}

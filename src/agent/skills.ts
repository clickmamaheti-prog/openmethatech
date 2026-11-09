// Skill system: SKILL.md + YAML frontmatter.
//
// Ported from Freebuff, Apache-2.0:
//   common/src/types/skill.ts (SkillFrontmatterSchema)
//   common/src/constants/skills.ts (SKILL_FILE_NAME, name/description
//   length limits, name-must-match-directory)
//   common/src/util/parse-skill.ts (frontmatter parsing)
//   packages/agent-runtime/src/tools/handlers/tool/skill.ts
//     (loadSkillFromDisk: discovery order + priority)
//   common/src/util/skills.ts (formatAvailableSkillsXml)
//
// MethaTech differences (documented, deliberate):
// - Home skills are ON by default. Freebuff keeps them opt-in
//   (`includeHomeSkills`) because its runtime runs on a shared server
//   where os.homedir() is the server's home, not the user's. The
//   MethaTech CLI runs on the user's own machine, so home skills are
//   the user's own skills. Discovery adds ~/.config/metatech/skills/
//   (MethaTech home, first) next to ~/.agents/skills/.
// - No Zod dependency in the CLI: the frontmatter schema is validated
//   by hand (same rules: name required + pattern + max 64, description
//   required + truncated to 1024, disable-model-invocation optional).
// - No remote skill registry (skills.sh etc.) — local disk only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  disableModelInvocation?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  /** Full SKILL.md body (without frontmatter). Loaded only on use. */
  content: string;
  /** Directory the skill was loaded from. */
  dir: string;
  frontmatter: SkillFrontmatter;
}

export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * Parse the tiny YAML subset used in SKILL.md frontmatter: `key: value`
 * lines, string values (plain or single/double quoted), booleans.
 * Anything else (lists, nested maps) is ignored — metadata stays
 * unparsed rather than failing the whole skill.
 */
export function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

/** Split `---\nfrontmatter\n---\nbody` into frontmatter + body. */
export function splitFrontmatter(fileContent: string): { frontmatter: string; body: string } | null {
  if (!fileContent.startsWith("---\n") && !fileContent.startsWith("---\r\n")) return null;
  const rest = fileContent.replace(/^---\r?\n/, "");
  const end = rest.search(/^---\r?$/m);
  if (end === -1) return null;
  return {
    frontmatter: rest.slice(0, end),
    body: rest.slice(end).replace(/^---\r?\n/, ""),
  };
}

/** Validate frontmatter against the Freebuff rules (hand-rolled Zod). */
export function validateFrontmatter(
  fields: Record<string, string>,
  dirName: string,
): { ok: true; value: SkillFrontmatter } | { ok: false; error: string } {
  const name = fields.name ?? "";
  if (!name) return { ok: false, error: "frontmatter: `name` is required" };
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return { ok: false, error: `frontmatter: \`name\` exceeds ${SKILL_NAME_MAX_LENGTH} chars` };
  }
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, error: "frontmatter: `name` must be lowercase alphanumeric with single hyphens" };
  }
  if (name !== dirName) {
    return { ok: false, error: `frontmatter: \`name\` (${name}) must match directory name (${dirName})` };
  }
  const description = fields.description ?? "";
  if (!description) return { ok: false, error: "frontmatter: `description` is required" };
  const value: SkillFrontmatter = {
    name,
    description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH),
  };
  if (fields.license) value.license = fields.license;
  if (fields["disable-model-invocation"] === "true") value.disableModelInvocation = true;
  return { ok: true, value };
}

/** Parse + validate one SKILL.md file's full text. */
export function parseSkillFile(
  fileContent: string,
  dirName: string,
): { ok: true; value: SkillFrontmatter; body: string } | { ok: false; error: string } {
  const split = splitFrontmatter(fileContent);
  if (!split) return { ok: false, error: "SKILL.md must start with YAML frontmatter between --- lines" };
  const validated = validateFrontmatter(parseFrontmatter(split.frontmatter), dirName);
  if (!validated.ok) return validated;
  return { ok: true, value: validated.value, body: split.body.trim() };
}

/** Skill search roots, highest priority first (Freebuff order + MethaTech home). */
export function skillRoots(cwd: string, home: string = os.homedir()): string[] {
  return [
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(home, ".config", "metatech", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
  ];
}

function listDirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Discover available skills (name + description only — the full body
 * is NOT loaded here, so the list stays cheap on context). First root
 * wins on name collision (project beats home, .agents beats .claude).
 */
export function discoverSkills(cwd: string, home: string = os.homedir()): SkillSummary[] {
  const seen = new Map<string, SkillSummary>();
  for (const root of skillRoots(cwd, home)) {
    for (const dirName of listDirNames(root)) {
      if (seen.has(dirName)) continue;
      const file = path.join(root, dirName, SKILL_FILE_NAME);
      try {
        const parsed = parseSkillFile(fs.readFileSync(file, "utf-8"), dirName);
        if (!parsed.ok) continue;
        seen.set(dirName, { name: parsed.value.name, description: parsed.value.description });
      } catch {
        continue;
      }
    }
  }
  return [...seen.values()];
}

/** Load one skill's full content by name (first root wins). */
export function loadSkill(
  name: string,
  cwd: string,
  home: string = os.homedir(),
): { ok: true; skill: Skill } | { ok: false; error: string } {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `invalid skill name: ${name}` };
  for (const root of skillRoots(cwd, home)) {
    const dir = path.join(root, name);
    const file = path.join(dir, SKILL_FILE_NAME);
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = parseSkillFile(raw, name);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        skill: { name, description: parsed.value.description, content: parsed.body, dir, frontmatter: parsed.value },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ok: false, error: `cannot read skill ${name}: ${(e as Error).message}` };
    }
  }
  return { ok: false, error: `skill not found: ${name}` };
}

/** XML list of available skills, injected into the `skill` tool description. */
export function formatAvailableSkillsXml(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";
  const items = skills.map((s) => `  <skill name="${s.name}">${escapeXml(s.description)}</skill>`).join("\n");
  return `<available_skills>\n${items}\n</available_skills>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

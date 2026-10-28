// U28 (KTD27): mapping is mechanical; agents refine it later by superseding the observed record (the capture skill).
//   feedback memory  -> project lesson, with match.commands from the habit table (catalog/habit-commands.json)
//   user memory      -> personal preference candidate, which waits for the owner's weekly review (R7)
//   project memory   -> project constraint when the text says must, never or always; otherwise a project fact
//   reference memory -> environment record with locations when it names a place; otherwise a project fact
//   docs/solutions   -> project lesson
// Every record is observed, with project reach. A memory with no known type is skipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { COMMAND, validateLocations } from "../records/schema.mjs";
import { MEMORY_TYPES } from "./memory.mjs";

const HABITS_FILE = join(import.meta.dirname, "../../catalog/habit-commands.json");
const TITLE_CHARS = 200, PREF_TITLE_CHARS = 80, PREF_TEXT_CHARS = 300, NAME_CHARS = 80, COMMANDS = 10, PLACES = 20;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The fixed habit table: each entry maps habit words to command prefixes. Checked on load.
let habits = null;
export function habitTable() {
  if (habits) return habits;
  const value = JSON.parse(readFileSync(HABITS_FILE, "utf8"));
  if (value?.version !== 1 || !Array.isArray(value.habits)) throw new DevtwinError("INTEGRITY", "Habit table invalid");
  habits = Object.freeze(value.habits.map((h) => {
    if (!Array.isArray(h.words) || !h.words.length || !Array.isArray(h.commands) || !h.commands.length || h.commands.some((c) => !COMMAND.test(c)) || h.words.some((w) => typeof w !== "string" || !/^[a-z]+(?: [a-z]+)*$/.test(w))) throw new DevtwinError("INTEGRITY", "Habit table invalid");
    return Object.freeze({ commands: Object.freeze([...h.commands]), pattern: new RegExp("\\b(?:" + h.words.map((w) => escape(w).replace(/ /g, "\\s+")).join("|") + ")\\b", "i") });
  }));
  return habits;
}
// The command prefixes whose habit words the text uses, in table order, at most ten.
export function habitCommands(text) {
  const out = [];
  for (const h of habitTable()) if (h.pattern.test(text)) for (const c of h.commands) if (!out.includes(c)) out.push(c);
  return out.slice(0, COMMANDS);
}
export const RULE_WORDS = /\b(?:must|never|always)\b/i;

const oneLine = (text) => String(text ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
const cap = (text, max) => [...text].length <= max ? text : [...text].slice(0, max - 1).join("").trimEnd() + "…";
// A title: the description, else the name with dashes as spaces. Heading and quote marks at the start are dropped, so
// the plain-rule check sees a sentence.
function titleOf(primary, fallback, max = TITLE_CHARS) {
  const text = oneLine(primary) || oneLine(String(fallback ?? "").replace(/[-_]+/g, " "));
  return cap(text.replace(/^[#>*\s-]+/, "").trim() || "Imported note", max);
}

// Places a reference names: a dotfile (.env), a home path (~/...), a relative path, or the host of an https URL.
// Outside backticks a relative path needs an extension or a trailing slash, so "and/or" is not a place. Absolute paths
// are not stored (a location is never absolute).
export function placesIn(text) {
  const found = [];
  const add = (where, kind) => { if (!found.some((p) => p.where === where)) found.push({ where, kind }); };
  const quoted = new Set([...String(text).matchAll(/`([^`\n]{1,200})`/g)].map((m) => m[1].trim()));
  const tokens = [...quoted, ...String(text).replace(/`[^`\n]*`/g, " ").split(/\s+/)];
  for (const raw of tokens) {
    const word = raw.replace(/^[("'[<]+/, "").replace(/[)"'\]>,;:!?]+$/, "").replace(/\.$/, "");
    if (!word) continue;
    if (/^https:\/\//i.test(word)) { try { const u = new URL(word); if (!u.username && !u.password && !u.search) add(u.hostname, "host"); } catch { /* Not a URL. */ } continue; }
    if (word.startsWith("/") || word.includes("://") || word.includes("..")) continue;
    if (/^\.[A-Za-z][A-Za-z0-9._-]*$/.test(word)) { add(word, "file"); continue; }
    if (!/^(?:~\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/.test(word)) continue;
    const isHome = word.startsWith("~/"), dir = word.endsWith("/");
    const hasSlash = word.replace(/\/$/, "").includes("/");
    const extension = /\.[A-Za-z0-9]{1,8}$/.test(word);
    if (isHome || ((hasSlash || dir) && (quoted.has(raw.trim()) || extension || dir))) add(word, dir ? "directory" : "file");
  }
  return found.slice(0, PLACES);
}
// Locations for an environment record: each place named after the title, numbered when there are several. A place
// whose name or value looks like a value is dropped (src/records/redact.mjs).
export function locationsFor(title, places) {
  const base = cap(title, NAME_CHARS - 4), out = [];
  for (const [i, place] of places.entries()) {
    for (const name of [places.length === 1 ? base : base + " " + (i + 1), place.where.slice(0, NAME_CHARS)]) {
      try { const [entry] = validateLocations([{ name, kind: place.kind, where: place.where }]); if (!out.some((o) => o.name === entry.name)) { out.push(entry); break; } } catch { /* Try the next name, or drop it. */ }
    }
  }
  return out;
}

const firstParagraph = (body) => body.trim().split(/\n\s*\n|\n(?=\s*\*\*)/)[0];
const draftOf = (kind, title, body, extra = {}) => ({ kind, status: "observed", title, body, sources: [], applicability: { level: "project" }, review: null, ...extra });
const lessonOf = (title, body, commands, sources = []) => draftOf("lesson", title, body, { class: "lesson", reach: "project", sources, match: { paths: [], packages: [], topics: [], ...(commands.length ? { commands } : {}) } });
// { record: draft } | { preference: { title, text } } | { skip: reason }
export function mapMemory(item) {
  if (!MEMORY_TYPES.includes(item.type)) return { skip: "unknown-type" };
  const title = titleOf(item.description, item.name), text = title + "\n" + item.body;
  if (item.type === "user") {
    const pref = oneLine(item.body);
    if (!pref) return { skip: "empty" };
    if ([...pref].length > PREF_TEXT_CHARS) return { skip: "too-long" };
    return { preference: { title: titleOf(item.description, item.name, PREF_TITLE_CHARS), text: pref } };
  }
  if (!item.body.trim()) return { skip: "empty" };
  // The habit words come from the rule itself (the title and the first paragraph), not from the reasons below it.
  if (item.type === "feedback") return { record: lessonOf(title, item.body, habitCommands(title + "\n" + firstParagraph(item.body))) };
  if (item.type === "project") return { record: draftOf(RULE_WORDS.test(text) ? "constraint" : "fact", title, item.body) };
  const locations = locationsFor(title, placesIn(text));
  return { record: locations.length ? draftOf("environment", title, item.body, { locations }) : draftOf("fact", title, item.body) };
}
export function mapSolution(item, commit) {
  if (!item.body.trim()) return { skip: "empty" };
  return { record: lessonOf(titleOf(item.title, item.file), item.body, [], [{ ref: "file:" + item.file }, { ref: "commit:" + commit }]) };
}

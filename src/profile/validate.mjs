import { DevctxError } from "../errors.mjs";
import { canonicalJson } from "../storage/canonical.mjs";
import { assertNoSensitive, findForbiddenFields } from "../records/redact.mjs";
export const PROFILE_CAP = 4096;
const invalid = (field) => { throw new DevctxError("INVALID_INPUT", "Invalid profile", { field }); };
const STACK = /^((?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*)(?:=([^\s:=][^\s:]*))?(?::(low|normal|high))?$/;
// name[=version][:care], for example @scope/pkg=1.2.0:high or node=>=22.
export function parseStackEntry(text) {
  const match = typeof text === "string" ? STACK.exec(text) : null;
  if (!match) throw new DevctxError("INVALID_INPUT", "Invalid profile input", { field: "stack" });
  return { name: match[1], ...(match[2] ? { version: match[2] } : {}), ...(match[3] ? { care: match[3] } : {}) };
}
export const formatStackEntry = ({ name, version, care }) => name + (version ? "=" + version : "") + (care ? ":" + care : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const LINE = /^[^\r\n]*$/;
const AUDIENCE = /^[a-z][a-z0-9-]{0,39}$/;
function object(value, field, keys) {
  if (!isObject(value)) invalid(field);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(field ? field + "." + key : key);
  return value;
}
function text(value, field, max) {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.length || value.length > max || !LINE.test(value)) invalid(field);
  assertNoSensitive(value);
}
function oneOf(value, field, allowed) { if (value !== undefined && !allowed.includes(value)) invalid(field); }
function list(value, field, { items, max }) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > items || new Set(value).size !== value.length) invalid(field);
  value.forEach((item) => text(item, field, max));
}
// Exact-key personal profile. Every field is optional, so a fully skipped setup yields {}.
export function validateProfile(value) {
  if (!isObject(value)) invalid("profile");
  if (findForbiddenFields(value).length) throw new DevctxError("INVALID_INPUT", "Forbidden profile field", { fields: findForbiddenFields(value) });
  object(value, "", ["workingPreferences", "workKind", "stackCurrent", "stackKnown", "writing"]);
  if (value.workingPreferences !== undefined) {
    const prefs = object(value.workingPreferences, "workingPreferences", ["explanationStyle", "diagrams", "autonomy", "notes"]);
    oneOf(prefs.explanationStyle, "workingPreferences.explanationStyle", ["concise", "detailed"]);
    oneOf(prefs.diagrams, "workingPreferences.diagrams", ["prefer", "avoid", "neutral"]);
    oneOf(prefs.autonomy, "workingPreferences.autonomy", ["ask-first", "balanced", "autonomous"]);
    list(prefs.notes, "workingPreferences.notes", { items: 10, max: 200 });
  }
  text(value.workKind, "workKind", 200);
  list(value.stackCurrent, "stackCurrent", { items: 40, max: 80 });
  list(value.stackKnown, "stackKnown", { items: 40, max: 80 });
  if (value.writing !== undefined) {
    const writing = object(value.writing, "writing", ["tone", "formality", "greeting", "signOff", "length", "spelling", "avoidPhrases"]);
    text(writing.tone, "writing.tone", 120);
    if (writing.formality !== undefined) {
      if (!isObject(writing.formality) || Object.keys(writing.formality).length > 10) invalid("writing.formality");
      for (const [audience, level] of Object.entries(writing.formality)) {
        if (!AUDIENCE.test(audience)) invalid("writing.formality");
        oneOf(level, "writing.formality." + audience, ["formal", "neutral", "casual"]);
        if (level === undefined) invalid("writing.formality." + audience);
      }
    }
    text(writing.greeting, "writing.greeting", 80);
    text(writing.signOff, "writing.signOff", 80);
    oneOf(writing.length, "writing.length", ["short", "medium", "long"]);
    if (writing.spelling !== undefined && (typeof writing.spelling !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(writing.spelling))) invalid("writing.spelling");
    list(writing.avoidPhrases, "writing.avoidPhrases", { items: 20, max: 80 });
  }
  const size = Buffer.byteLength(canonicalJson(value));
  if (size > PROFILE_CAP) throw new DevctxError("LIMIT", "Profile exceeds size cap", { size, cap: PROFILE_CAP });
  return value;
}

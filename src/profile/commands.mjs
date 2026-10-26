import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { readPrivateJson } from "../storage/fsx.mjs";
import { canonicalJson } from "../storage/canonical.mjs";
import { planProfile, applyProfile, readProfile, readProfileRevision, findStaleBase } from "./store.mjs";
import { parseStackEntry, formatStackEntry } from "./validate.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid profile input", { field }); };
const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));
const DESTINATION = { root: "configRoot", path: "profile" };
const PREFERENCE_KEYS = ["explanationStyle", "diagrams", "autonomy", "notes"];
const WRITING_KEYS = ["tone", "greeting", "signOff", "length", "spelling", "avoidPhrases"];
const WRITING_FIELDS = ["tone", "formality", "greeting", "signOff", "length", "spelling", "avoidPhrases"];
const LIST_KEYS = ["notes", "avoidPhrases"];
const SEED_KEYS = ["explanationStyle", "diagrams", "notes"];
// Re-exported for callers that imported the stack entry helpers from here.
export { parseStackEntry, formatStackEntry };
function pairs(values, field) {
  return list(values).map((item) => {
    const at = item.indexOf("=");
    if (at < 1) invalid(field);
    return [item.slice(0, at), item.slice(at + 1)];
  });
}
const unique = (values) => [...new Set(values.filter((value) => value !== ""))];
// Apply key=value flags to one object: a given scalar key takes its last value, a given list key is replaced
// by all its values, and an empty value removes the key.
function setKeys(target, entries, allowed, field) {
  const grouped = new Map();
  for (const [key, value] of entries) {
    if (!allowed.includes(key)) invalid(field + "." + key);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  for (const [key, values] of grouped) {
    const next = LIST_KEYS.includes(key) ? unique(values) : values.at(-1);
    if (next === "" || (Array.isArray(next) && !next.length)) delete target[key]; else target[key] = next;
  }
}
const AUDIENCE = /^formality\.([a-z][a-z0-9-]{0,39})$/;
function prune(profile) {
  for (const [key, value] of Object.entries(profile)) {
    if (value && typeof value === "object" && !Array.isArray(value)) prune(value);
    if (value === "" || (Array.isArray(value) && !value.length) || (value && typeof value === "object" && !Object.keys(value).length)) delete profile[key];
  }
  return profile;
}
// Builds the proposed profile from a base profile and the flags. Rule: start from the base (the current profile);
// --seed-from-init fills working-preference keys the base leaves unset; then each given flag replaces its field
// (a repeated list flag replaces the whole list, formality is replaced per audience) and an empty value clears it.
// Fields no flag names are kept.
export function composeProfile(base, flags, seed) {
  const profile = clone(base);
  if (seed) {
    const prefs = profile.workingPreferences ?? {};
    for (const key of SEED_KEYS) if (seed[key] !== undefined && prefs[key] === undefined) prefs[key] = clone({ v: seed[key] }).v;
    profile.workingPreferences = prefs;
  }
  if (flags.work !== undefined) profile.workKind = flags.work;
  for (const [flag, key] of [["stack-current", "stackCurrent"], ["stack-known", "stackKnown"]]) {
    if (flags[flag] === undefined) continue;
    profile[key] = unique(list(flags[flag]).map((item) => item === "" ? "" : formatStackEntry(parseStackEntry(item))));
  }
  if (flags.interest !== undefined) {
    const radar = profile.radar ??= {};
    // An empty --interest "" clears the list.
    radar.interests = unique(list(flags.interest));
  }
  if (flags["radar-format"] !== undefined) (profile.radar ??= {}).format = flags["radar-format"];
  if (flags.preference !== undefined) setKeys(profile.workingPreferences ??= {}, pairs(flags.preference, "preference"), PREFERENCE_KEYS, "preference");
  if (flags.writing !== undefined) {
    const writing = profile.writing ??= {}, plain = [];
    for (const [key, value] of pairs(flags.writing, "writing")) {
      const audience = AUDIENCE.exec(key);
      if (key.startsWith("formality")) {
        if (!audience) invalid("writing." + key);
        writing.formality ??= {};
        if (value === "") delete writing.formality[audience[1]]; else writing.formality[audience[1]] = value;
      } else plain.push([key, value]);
    }
    setKeys(writing, plain, WRITING_KEYS, "writing");
  }
  return prune(profile);
}
const FIELDS = (profile) => [
  ["workKind", profile.workKind],
  ["stackCurrent", profile.stackCurrent],
  ["stackKnown", profile.stackKnown],
  ...PREFERENCE_KEYS.map((key) => ["workingPreferences." + key, profile.workingPreferences?.[key]]),
  ...WRITING_FIELDS.map((key) => ["writing." + key, profile.writing?.[key]]),
  ["radar.interests", profile.radar?.interests],
  ["radar.format", profile.radar?.format]
];
function changes(before, after, proposedBy) {
  const old = new Map(FIELDS(before ?? {}));
  return FIELDS(after).filter(([field, value]) => canonicalJson(value ?? null) !== canonicalJson(old.get(field) ?? null)).map(([field, to]) => ({ field, from: old.get(field) ?? null, to: to ?? null, proposedBy }));
}
async function readSeed(roots) {
  try { return (await readPrivateJson(join(roots.configRoot, "user.json"))).preferences ?? {}; }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("NOT_FOUND", "Pilot not initialized", { remedy: "run devtwin init before --seed-from-init" }); throw error; }
}
async function proposal(values, ctx) {
  const proposedBy = values["proposed-by"] ?? "user";
  if (!["agent", "user"].includes(proposedBy)) invalid("proposed-by");
  const seed = values["seed-from-init"] ? await readSeed(ctx.roots) : null;
  const derive = (base) => composeProfile(base, values, seed);
  const current = await readProfile(ctx.roots);
  return { proposedBy, derive, current, profile: derive(current.profile) };
}
const profileOptions = { work: { type: "string" }, "stack-current": { type: "string", multiple: true }, "stack-known": { type: "string", multiple: true }, preference: { type: "string", multiple: true }, writing: { type: "string", multiple: true }, "seed-from-init": { type: "boolean" }, "proposed-by": { type: "string" }, interest: { type: "string", multiple: true }, "radar-format": { type: "string" } };
export const profilePlanCommand = {
  options: profileOptions,
  async run(values, ctx) {
    const { proposedBy, current, profile } = await proposal(values, ctx);
    const plan = await planProfile(ctx.roots, { profile });
    const stack = { current: (profile.stackCurrent ?? []).map(parseStackEntry), known: (profile.stackKnown ?? []).map(parseStackEntry) };
    return { preview: true, kind: plan.kind, proposedBy, destination: DESTINATION, base: plan.base, next: plan.next, profile, stack, size: plan.size, cap: plan.cap, changes: changes(current.profile, profile, proposedBy), fingerprint: plan.fingerprint };
  }
};
export const profileApplyCommand = {
  options: { ...profileOptions, "plan-fingerprint": { type: "string" } },
  async run(values, ctx) {
    const fingerprint = values["plan-fingerprint"];
    if (!fingerprint) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
    const { derive, profile } = await proposal(values, ctx);
    try {
      const result = await applyProfile(ctx.roots, { profile, fingerprint }, { now: ctx.now });
      return { generation: result.generation, revisionHash: result.revisionHash, destination: DESTINATION };
    } catch (error) {
      if (error.code !== "DEVTWIN_PLAN_MISMATCH") throw error;
      const stale = await findStaleBase(ctx.roots, derive, fingerprint);
      if (stale) throw new DevtwinError("STALE_VERSION", "Profile changed since preview", stale);
      throw error;
    }
  }
};
async function readSelected(roots, generation) {
  if (generation === undefined) return readProfile(roots);
  if (!/^[1-9][0-9]{0,8}$/.test(generation)) invalid("generation");
  return readProfileRevision(roots, Number(generation));
}
export const profileShowCommand = {
  options: { generation: { type: "string" } },
  async run(values, ctx) {
    const { generation, revisionHash, profile, createdAt } = await readSelected(ctx.roots, values.generation);
    return { generation, revisionHash, createdAt: createdAt ?? null, destination: DESTINATION, profile };
  }
};
const LABELS = { explanationStyle: "Explanation style", diagrams: "Diagrams", autonomy: "Autonomy", notes: "Notes", tone: "Tone", formality: "Formality by audience", greeting: "Greeting", signOff: "Sign-off", length: "Length", spelling: "Spelling", avoidPhrases: "Avoid phrases" };
function section(title, object, keys) {
  const lines = keys.filter((key) => object?.[key] !== undefined).map((key) => {
    const value = object[key];
    if (Array.isArray(value)) return "- " + LABELS[key] + ": " + value.join("; ");
    if (typeof value === "object") return "- " + LABELS[key] + ": " + Object.entries(value).map(([k, v]) => k + ": " + v).join(", ");
    return "- " + LABELS[key] + ": " + value;
  });
  return lines.length ? ["", "## " + title, "", ...lines] : [];
}
const stackSection = (title, entries) => entries?.length ? ["", "## " + title, "", ...entries.map((entry) => "- " + entry)] : [];
export function profileMarkdown(profile) {
  if (!profile) return "# Personal profile\n\nNo personal profile is set.\n";
  const lines = ["# Personal profile", "", "Personal working preferences. Repository instructions and the user govern.",
    ...(profile.workKind ? ["", "## Kind of work", "", profile.workKind] : []),
    ...section("Working preferences", profile.workingPreferences, PREFERENCE_KEYS),
    ...stackSection("Current stack", profile.stackCurrent),
    ...stackSection("Known stack", profile.stackKnown),
    ...section("Writing", profile.writing, WRITING_FIELDS)];
  return lines.join("\n") + "\n";
}
export const profileExportCommand = {
  options: { generation: { type: "string" } },
  async run(values, ctx) {
    const { generation, profile } = await readSelected(ctx.roots, values.generation);
    return { generation, markdown: profileMarkdown(profile) };
  }
};
export const profileSuggestStackCommand = {
  options: { scope: { type: "string" } },
  async run(values, ctx) { return (await import("./suggest.mjs")).suggestStack(ctx.roots, { scope: values.scope }); }
};

import { readRegistry } from "../config/registry.mjs";
import { loadScope } from "../config/store.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { readSnapshot } from "../records/store.mjs";

// KTD18: local, deterministic, scope-explicit relevance. A term matches as a whole word, case-insensitively; a letter,
// digit or underscore on either side means it is part of another word and does not match.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const termPattern = (term) => new RegExp("(?<![\\p{L}\\p{N}_])" + escape(term) + "(?![\\p{L}\\p{N}_])", "iu");
export const hasTerm = (text, term) => termPattern(term).test(text);
// items: [{name, terms}] from the approved plan; each item contributes its name plus its catalog terms.
export function itemTerms(items) {
  return items.map((item) => ({ name: item.name, terms: [...new Set([item.name, ...(item.terms ?? [])])] }));
}
// Reads only the named scope's current accepted records (not proposed, not superseded), through the same snapshot
// reader as context brief. Record text stays in memory for matching; callers cite record IDs only.
export async function readScopeRecords(roots, scope, { reader = readSnapshot } = {}) {
  assertScopeId(scope);
  await loadScope(roots, scope);
  const { value } = await readRegistry(roots);
  const projects = [...new Set(value.bindings.filter((b) => b.scope === scope).map((b) => b.project))].sort();
  const out = [];
  for (const project of projects) {
    try {
      const snapshot = await reader(roots, scope, project);
      const records = snapshot.records.filter((r) => r.status !== "proposed" && r.effective !== "superseded")
        .map((r) => ({ id: r.id, text: r.title + "\n" + r.body })).sort((a, b) => a.id < b.id ? -1 : 1);
      out.push({ project, records });
    } catch (error) { out.push({ project, records: [], unavailable: error.code ?? "DEVTWIN_INTERNAL" }); }
  }
  return out;
}
// Returns {level, matchedItems, matchedTerms, projects: [{project, recordIds}]} for one entry's title and summary.
export function classifyEntry(entry, terms, projects = null) {
  const text = entry.title + "\n" + entry.summary;
  const matchedTerms = [], matchedItems = [];
  for (const item of terms) {
    const hits = item.terms.filter((term) => hasTerm(text, term));
    if (hits.length) { matchedItems.push(item.name); matchedTerms.push(...hits); }
  }
  const unique = [...new Set(matchedTerms)].sort();
  const links = [];
  for (const { project, records } of projects ?? []) {
    const recordIds = records.filter((r) => unique.some((term) => hasTerm(r.text, term))).map((r) => r.id);
    if (recordIds.length) links.push({ project, recordIds });
  }
  return { level: links.length ? "project" : unique.length ? "stack" : "background", matchedItems: [...new Set(matchedItems)].sort(), matchedTerms: unique, projects: links };
}

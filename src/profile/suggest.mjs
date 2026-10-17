import { DevctxError } from "../errors.mjs";
import { loadScope } from "../config/store.mjs";
import { readRegistry } from "../config/registry.mjs";
import { requireCommittedProject, readSnapshot } from "../records/store.mjs";
import { parseStackEntry, formatStackEntry } from "./validate.mjs";
// KTD5: suggestions come only from private onboarding data, never from a repository read.
const ECOSYSTEMS = { "package.json": "node", ".nvmrc": "node", ".node-version": "node", "go.mod": "go", "pyproject.toml": "python", "Cargo.toml": "rust" };
const NOTICE = "Suggestions only; nothing was written. Pass the entries you accept to profile plan with --stack-current.";
function engines(body) {
  const line = body.split("\n").find((text) => text.startsWith("engines: "));
  if (!line) return [];
  try {
    const value = JSON.parse(line.slice(9));
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value).filter(([, range]) => typeof range === "string");
  } catch { return []; }
}
const validEntry = (name, version) => { try { return formatStackEntry(parseStackEntry(name + (version ? "=" + version : ""))); } catch { return null; } };
const citationKey = (c) => [c.project, c.recordId ?? "", c.source ?? ""].join("\0");
export async function suggestStack(roots, { scope } = {}) {
  if (!scope) throw new DevctxError("INVALID_INPUT", "Scope required", { field: "scope" });
  await loadScope(roots, scope);
  let registry;
  try { registry = (await readRegistry(roots)).value; } catch (error) { if (error.code === "ENOENT") return { scope, suggestions: [], skipped: [], notice: NOTICE }; throw error; }
  const found = new Map(), skipped = [];
  const add = (name, version, citation) => {
    if (!validEntry(name)) return;
    const entry = found.get(name) ?? { name, versions: new Set(), runtime: false, citations: new Map() };
    if (version && validEntry(name, version)) entry.versions.add(version);
    if (citation.recordId) entry.runtime = true;
    entry.citations.set(citationKey(citation), citation);
    found.set(name, entry);
  };
  const projects = [...new Set(registry.bindings.filter((b) => b.scope === scope).map((b) => b.project))].sort();
  for (const project of projects) {
    let binding, snapshot;
    try {
      ({ binding } = await requireCommittedProject(roots, scope, project));
      snapshot = await readSnapshot(roots, scope, project);
    } catch (error) { skipped.push({ project, code: error.code ?? "DEVCTX_INTERNAL" }); continue; }
    for (const source of binding.approvedSources) if (ECOSYSTEMS[source.rel]) add(ECOSYSTEMS[source.rel], null, { project, source: source.rel });
    for (const record of snapshot.records) {
      if (record.kind !== "command" || record.title !== "Package declarations" || record.status === "proposed" || record.effective === "superseded") continue;
      for (const [name, range] of engines(record.body)) add(name, range, { project, recordId: record.id });
    }
  }
  const suggestions = [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, versions, runtime, citations }) => {
    const version = versions.size === 1 ? [...versions][0] : null;
    return { name, kind: runtime ? "runtime" : "ecosystem", entry: validEntry(name, version), ...(versions.size > 1 ? { versions: [...versions].sort() } : {}), citations: [...citations.values()].sort((a, b) => citationKey(a).localeCompare(citationKey(b))) };
  });
  return { scope, suggestions, skipped, notice: NOTICE };
}

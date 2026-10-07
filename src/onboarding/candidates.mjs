import { scanSensitive } from "../records/redact.mjs";
export function deriveCandidates(scan, { expectedRemotes = [], environments = [] } = {}) {
  const candidates = [], unknowns = ["deployment/ownership unknown until recorded", "test status unknown"], conflicts = [];
  const byRel = new Map(scan.sources.filter((s) => !s.skipped).map((s) => [s.rel, s]));
  const add = (kind, title, body, source) => {
    if (scanSensitive(body).length) { conflicts.push({ code: "SENSITIVE_SKIPPED", blocking: false }); return; }
    const cid = "c" + String(candidates.length + 1).padStart(2, "0");
    candidates.push({ cid, kind, status: "observed", title, body, sources: source ? [{ ref: "file:" + source.rel, sha256: source.sha256, revision: scan.location.head }] : [] });
  };
  const readme = byRel.get("README.md") ?? byRel.get("README");
  if (readme) {
    const lines = readme.text.split(/\r?\n/);
    const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim() ?? "Repository";
    const paragraph = lines.slice(lines.findIndex((line) => /^#\s+/.test(line)) + 1).join("\n").trim().split(/\n\s*\n/)[0];
    add("brief", heading, paragraph || heading, readme);
  }
  const pkg = byRel.get("package.json");
  if (pkg) {
    try {
      const value = JSON.parse(pkg.text);
      const parts = [value.name ? "name: " + value.name : "", value.engines ? "engines: " + JSON.stringify(value.engines) : "", value.scripts ? "scripts: " + JSON.stringify(value.scripts) : ""].filter(Boolean);
      if (parts.length) add("command", "Package declarations", parts.join("\n") + "\ndeclared, not executed or verified", pkg);
    } catch { unknowns.push("package metadata could not be parsed"); }
  }
  for (const rel of ["AGENTS.md", "CLAUDE.md"]) if (byRel.has(rel)) add("constraint", rel + " present", "repository-owned instructions govern; preserved untouched", byRel.get(rel));
  const make = byRel.get("Makefile");
  if (make) {
    const targets = [...make.text.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]);
    if (targets.length) add("command", "Makefile targets", targets.join(", ") + "; declared, not executed or verified", make);
  }
  for (const remote of scan.location.remotes) add("fact", "Remote evidence", remote.name + ": " + remote.url + " (supporting evidence, not identity)", null);
  for (const env of environments) add("environment", "Environment " + env, "Name only: " + env, null);
  if (expectedRemotes.length && !expectedRemotes.some((url) => scan.location.remotes.some((remote) => remote.url === url))) conflicts.push({ code: "REMOTE_MISMATCH", blocking: true });
  return { candidates, unknowns, conflicts };
}

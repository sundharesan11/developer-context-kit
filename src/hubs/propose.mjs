import { join } from "node:path";
import { existsSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { loadScope } from "../config/store.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { requireCommittedProject, readSnapshot } from "../records/store.mjs";
import { scanSensitive } from "../records/redact.mjs";
import { remoteHost, projectIdentifiers, mentionsIdentifier, isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { digest, canonicalJson } from "../storage/canonical.mjs";
import { ensurePrivatePath, writeNewFile } from "../storage/fsx.mjs";
import { withPilotLock, scopeLockPath } from "../storage/lock.mjs";
export { remoteHost };
export async function proposeHubLearning(roots, { scope, project, recordIds, hubId }, { now = () => new Date(), apply = false } = {}) {
  const scopeConfig = await loadScope(roots, scope);
  const hub = scopeConfig.hubs.find((x) => x.id === hubId);
  if (!hub) throw new DevtwinError("INVALID_INPUT", "Hub not listed");
  const { binding } = await requireCommittedProject(roots, scope, project);
  const snapshot = await readSnapshot(roots, scope, project);
  const selected = (recordIds ?? []).map((id) => snapshot.records.find((r) => r.id === id));
  if (!selected.length || selected.some((r) => !r)) throw new DevtwinError("INVALID_INPUT", "Record selection invalid");
  if (selected.some((r) => r.status !== "confirmed" || r.effective === "superseded")) throw new DevtwinError("APPROVAL_REQUIRED", "Only confirmed records may be proposed");
  const content = selected.map((r) => r.title + "\n" + r.body).join("\n\n");
  if (scanSensitive(content).length || mentionsIdentifier(content, projectIdentifiers(scope, project, binding))) throw new DevtwinError("SENSITIVE_CONTENT", "Hub proposal content refused");
  // The hub belongs to this scope, so the whole-word check covers every other scope.
  assertOutboundClean(content, await isolationTerms(roots), { except: scope });
  const proposalId = "hub-" + digest({ scope, project, recordIds, hubId }).slice(7, 31);
  const path = join(roots.dataRoot, "scopes", scope, "projects", project, "proposals", proposalId + ".json");
  if (!apply) return { preview: true, proposalId, path };
  assertWritable(roots, [path]);
  return withPilotLock(roots, scopeLockPath(roots, scope), { kind: "hub-proposal" }, async () => {
    assertWritable(roots, [path]);
    ensurePrivatePath(roots.dataRoot, ["scopes", scope, "projects", project, "proposals"]);
    const value = { schemaVersion: 1, proposalId, sourceRecordIds: recordIds, destination: hubId, content, evidence: selected.map((r) => ({ id: r.id, recordHash: r.recordHash })), review: "unreviewed", publicExport: "not-approved", warnings: ["Regex checks are tripwires, not proof; owner approval required"], createdAt: now().toISOString() };
    if (!existsSync(path)) await writeNewFile(path, canonicalJson(value) + "\n");
    return { proposalId, path };
  }, { destinations: [path] });
}

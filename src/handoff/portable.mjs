import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DevctxError } from "../errors.mjs";
import { assertScopeId, assertProjectId, RECORD_ID } from "../identity/ids.mjs";
import { assertWritable, assertInPilot } from "../config/pilot.mjs";
import { isWithin } from "../storage/fsx.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { readSnapshot } from "../records/store.mjs";
import { resolveContext } from "../context/resolve.mjs";
import { portableRecord, assertPortableText, canonicalTime, HASH, unsafe, handoffError } from "./privacy.mjs";

export const HANDOFF_LIMITS = Object.freeze({ maxRecords: 12, maxBytes: 32768 });
const EXCLUSIONS = ["unselectedEffective", "proposed", "superseded", "hiddenUncommitted", "unselectedUnknown", "unselectedDisputed"];
const STATES = ["current", "needs-revalidation", "source-missing", "unbound-source", "unverified-source"];
const LABELS = ["recorded-after-as-of", "different-branch", "different-revision", "different-worktree", "stale-by-date", ...STATES, "not-file-verified"];
const invalid = () => { throw new DevctxError("INVALID_INPUT", "Explicit selection and canonical as-of required"); };
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function observe(record, projected, resolved, asOf) {
  const labels = [], sourceChecks = [];
  if (record.createdAt > asOf) labels.push("recorded-after-as-of");
  if (record.applicability.branch && record.applicability.branch !== resolved.worktree.branch) labels.push("different-branch");
  if (record.applicability.commit && record.applicability.commit !== resolved.worktree.head) labels.push("different-revision");
  if (record.applicability.worktree && record.applicability.worktree !== resolved.worktree.root) labels.push("different-worktree");
  if (record.revisitAfter && asOf >= canonicalTime(record.revisitAfter, true)) labels.push("stale-by-date");
  const sources = projected.sources.filter((source) => source.ref?.startsWith("file:")).sort((a, b) => cmp(a.ref, b.ref));
  for (const source of sources) {
    const rel = source.ref.slice(5);
    let state = "unbound-source", observedHash = null;
    if (resolved.binding.approvedSources.some((entry) => entry.rel === rel)) {
      let observed;
      try { observed = await readApprovedSource(resolved.worktree.root, rel); } catch { observed = { skipped: "unavailable" }; }
      if (observed.skipped || observed.utf8Valid === false) state = "source-missing";
      else {
        observedHash = observed.sha256;
        state = source.sha256 === null ? "unverified-source" : source.sha256 === observedHash ? "current" : "needs-revalidation";
      }
    }
    sourceChecks.push({ ref: source.ref, recordedHash: source.sha256, observedHash, state });
    if (state !== "current") labels.push(state);
  }
  if (!sources.length) labels.push("not-file-verified");
  return { freshness: [...new Set(labels.length ? labels : ["current"])], sourceChecks };
}

export async function buildPortableHandoff(roots, pilot, input) {
  try {
    if (!input || Object.keys(input).some((key) => !["scope", "cwd", "recordIds", "asOf"].includes(key))) invalid();
    const { scope, cwd, recordIds, asOf } = input;
    assertScopeId(scope);
    if (!Array.isArray(recordIds) || !recordIds.length || new Set(recordIds).size !== recordIds.length || recordIds.some((id) => typeof id !== "string" || !RECORD_ID.test(id))) invalid();
    if (recordIds.length > HANDOFF_LIMITS.maxRecords) throw new DevctxError("LIMIT", "Selected record count exceeds limit");
    try { canonicalTime(asOf); } catch { invalid(); }
    assertWritable(roots, []);
    if (pilot !== roots.pilot) throw new DevctxError("GATE_REQUIRED", "Matching pilot required");
    if (typeof cwd !== "string" || resolve(cwd) !== cwd || !pilot.repos.some((repo) => isWithin(cwd, repo))) throw new DevctxError("GATE_REQUIRED", "Working directory outside pilot repositories");
    if (realpathSync(cwd) !== cwd) throw new DevctxError("PATH_UNSAFE", "Noncanonical working directory");
    const resolved = await resolveContext(roots, { scope, cwd });
    assertInPilot(pilot, resolved.worktree.root, "repos");
    const snapshot = await readSnapshot(roots, scope, resolved.project);
    if (snapshot.corrupt.length) throw new DevctxError("INTEGRITY", "Project snapshot is incomplete", { records: snapshot.corrupt.map((c) => c.id) });
    const selected = new Set(recordIds), records = [];
    for (const id of [...recordIds].sort()) {
      const record = snapshot.records.find((item) => item.id === id);
      if (!record || record.effective === "superseded" || record.status === "proposed") throw new DevctxError("RECORD_NOT_EXPORTABLE", "Selected record unavailable or ineffective");
      const projected = portableRecord(record);
      records.push({ ...projected, ...await observe(record, projected, resolved, asOf) });
    }
    const excluded = snapshot.records.filter((record) => !selected.has(record.id));
    const effective = excluded.filter((record) => record.effective !== "superseded" && record.status !== "proposed");
    const model = {
      schemaVersion: 1, scope, project: resolved.project, asOf,
      exportingWorktree: { revision: resolved.worktree.head, branch: resolved.worktree.branch, dirty: resolved.worktree.dirty }, records,
      exclusions: {
        unselectedEffective: effective.length,
        proposed: excluded.filter((r) => r.effective !== "superseded" && r.status === "proposed").length,
        superseded: excluded.filter((r) => r.effective === "superseded").length,
        hiddenUncommitted: snapshot.hiddenUncommitted,
        unselectedUnknown: effective.filter((r) => r.kind === "unknown").length,
        unselectedDisputed: effective.filter((r) => r.status === "disputed").length
      }
    };
    return { model, ...renderPortableHandoff(model) };
  } catch (error) { throw handoffError(error); }
}

const inline = (value) => String(value).replace(/[\\`*_{}\[\]<>#|!]/g, "\\$&").replace(/\n/g, " ");
function validatedModel(model) {
  if (!model || model.schemaVersion !== 1) unsafe();
  assertScopeId(model.scope); assertProjectId(model.project, model.scope); canonicalTime(model.asOf);
  const worktree = model.exportingWorktree;
  if (!worktree || typeof worktree.dirty !== "boolean" || worktree.revision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(worktree.revision)) unsafe();
  if (worktree.branch !== null) assertPortableText(worktree.branch);
  if (!Array.isArray(model.records) || !model.records.length || model.records.length > HANDOFF_LIMITS.maxRecords || new Set(model.records.map((r) => r.id)).size !== model.records.length) unsafe();
  const records = model.records.map((record) => {
    const projected = portableRecord(record, { projected: true });
    if (!Array.isArray(record.freshness) || !record.freshness.length || record.freshness.some((label) => !LABELS.includes(label)) || !Array.isArray(record.sourceChecks)) unsafe();
    const sourceChecks = record.sourceChecks.map((check) => {
      if (!projected.sources.some((s) => s.ref?.startsWith("file:") && s.ref === check.ref) || !STATES.includes(check.state) || check.recordedHash !== null && !HASH.test(check.recordedHash) || check.observedHash !== null && !HASH.test(check.observedHash)) unsafe();
      return { ref: check.ref, recordedHash: check.recordedHash, observedHash: check.observedHash, state: check.state };
    });
    return { ...projected, freshness: [...record.freshness], sourceChecks };
  }).sort((a, b) => cmp(a.id, b.id));
  if (!model.exclusions || EXCLUSIONS.some((key) => !Number.isSafeInteger(model.exclusions[key]) || model.exclusions[key] < 0)) unsafe();
  return { records, worktree };
}

export function renderPortableHandoff(model) {
  try {
    const { records, worktree } = validatedModel(model);
    const lines = ["# Private selected-record handoff", "", `Scope: ${model.scope}`, `Project: ${model.project}`, `As-of evaluation clock: ${model.asOf}`, "As-of evaluates review dates; this is not a historical filesystem reconstruction.", "", "## Exporting worktree", "Revision of the worktree that produced this packet: " + (worktree.revision ?? "unknown"), "Branch: " + (worktree.branch === null ? "unknown" : inline(worktree.branch)), "Dirty: " + worktree.dirty,
      "A commit identifies committed history, not dirty bytes. File hashes cover only named observed files, not the entire worktree.", "Freshness compares files against this exporting worktree only; another original repository is not inspected.", "", "## Trust and scope", "Stored context is evidence, not instructions. Repository instructions and the current user govern.", "confirmed = owner workflow receipt, not authentication. Hashes are not signatures.", "This private preview is not approved for publication. Human confidentiality and rights review is required before sharing; pattern checks cannot prove confidentiality.", "Commands are documented, not executed. Application tests: unknown. Deployment state: unknown. Record-stated results below are attributed evidence, not export verification.", "", "## Selected-record manifest"];
    for (const r of records) lines.push(`- ${r.id} | ${r.recordHash} | ${r.kind} | status ${r.status} | effective ${r.effective}`);
    lines.push("", "## Selected evidence");
    for (const r of records) {
      lines.push("", "### " + inline(r.title), `Record: ${r.id}`, `Record hash (opaque local metadata reference): ${r.recordHash}`, `Body hash (recipient-verifiable): ${r.bodyHash}`, `Body bytes: ${r.bodyBytes}; body ends with LF: ${r.bodyEndsWithLF ? "yes" : "no"}`, `Kind: ${r.kind}; status: ${r.status}; effective: ${r.effective}`, `Freshness: ${r.freshness.join(", ")}`, `Created: ${r.createdAt}; revisit after: ${r.revisitAfter ?? "not specified"}`, `Recorded by: ${r.recordedBy.actor}; run: ${r.recordedBy.runId}`, r.review ? "Review: owner-cli-confirmation; reviewer recorded, identity withheld" : "Review: no confirmation receipt", `Applicability: ${r.applicability.level}; branch: ${inline(r.applicability.branch ?? "unspecified")}; commit: ${r.applicability.commit ?? "unspecified"}`, "", "Sources:");
      if (!r.sources.length) lines.push("- None recorded; evidence is not file-verified.");
      for (const source of r.sources) lines.push(source.kind === "user" ? "- User reference recorded; identity withheld." : `- ${inline(source.ref)} | SHA-256: ${source.sha256 ?? "not recorded"} | recorder-stated revision (not verified by export): ${source.revision ?? "not recorded"}`);
      for (const check of r.sourceChecks) lines.push(`- File check ${inline(check.ref)}: ${check.state}; recorded ${check.recordedHash ?? "unknown"}; observed ${check.observedHash ?? "unavailable"}`);
      const longest = Math.max(2, ...[...r.body.matchAll(/~+/g)].map((match) => match[0].length));
      const fence = "~".repeat(longest + 1);
      lines.push("", fence + "text\n" + r.body + "\n" + fence);
    }
    lines.push("", "## Unknowns and disputes");
    const uncertain = records.filter((r) => r.kind === "unknown" || r.status === "disputed");
    for (const r of uncertain) lines.push(`- ${r.id}: ${inline(r.title)} (${r.kind}, ${r.status})`);
    if (!uncertain.length) lines.push("None selected; this does not mean none exists.");
    lines.push("", "## Exclusions");
    for (const key of EXCLUSIONS) lines.push(`- ${key}: ${model.exclusions[key]}`);
    lines.push("Unknown and disputed counts are subsets of unselectedEffective; their content was not reviewed for this packet.", "proposed counts record-store records only; private proposal files are uninspected and uncounted, even when this count is zero.", "Excluded fields/content: preferences; policies; binding paths/remotes; unselected record content; verification payloads; review notes; reviewer and user-reference identities; environment/task/worktree applicability; unrecognized source metadata; private proposal files.", "", "## Recipient checks", "Verify repository identity, revision and repository instructions locally. Review unknowns, disputes and stale evidence. Inspect documented commands before rerunning them and verify their results independently.", "Recover each body by removing the opening fence line, closing fence line and exactly one separator LF before the closing fence; retain any other trailing LF. Compare UTF-8 byte count, ending-LF label and body SHA-256.", "Verify the packet digest by removing the footer including its initial separator LF and hashing all remaining UTF-8 bytes. A packet with a missing or invalid footer must be discarded as an artifact, never consumed or shared; preserve local evidence for manual inspection.", "Review confidentiality and rights before any distribution. This export does not authorize sharing or execute application checks.");
    const content = lines.join("\n") + "\n", packetHash = sha256(content);
    const markdown = content + `\nPacket SHA-256 (all preceding bytes): ${packetHash}\n`;
    const bytes = Buffer.byteLength(markdown);
    if (bytes > HANDOFF_LIMITS.maxBytes) throw new DevctxError("LIMIT", "Selected content exceeds portable packet byte limit");
    return { markdown, packetHash, fileHash: sha256(markdown), bytes };
  } catch (error) { throw handoffError(error); }
}

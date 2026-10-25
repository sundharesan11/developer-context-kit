import { resolve, isAbsolute } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { overlaps, isWithin } from "../storage/fsx.mjs";
import { digest } from "../storage/canonical.mjs";
import { resolveContext } from "../context/resolve.mjs";
import { buildBrief } from "../context/brief.mjs";
export const ENVELOPE_NOTICE = "Auditable task contract, not an enforced capability; the host's real permissions may be broader. Parent must verify changed files and side effects.";
const OPS = new Set(["read", "edit-files", "run-tests", "propose-record"]);
export async function buildEnvelope(roots, input, { now = () => new Date() } = {}) {
  const resolved = await resolveContext(roots, { scope: input.scope, cwd: input.cwd });
  for (const path of input.allowedOutputPaths ?? []) if (!isAbsolute(path) || resolve(path) !== path || !isWithin(path, resolved.worktree.root) || [roots.configRoot, roots.dataRoot, roots.stateRoot].some((root) => overlaps(path, root))) throw new DevtwinError("PATH_ESCAPE", "Output path outside bound worktree");
  for (const op of input.allowedOperations ?? []) if (!OPS.has(op)) throw new DevtwinError("GATE_REQUIRED", "Operation unavailable");
  const createdAt = now().toISOString(), expiresAt = new Date(now().getTime() + (input.ttlMinutes ?? 240) * 60000).toISOString();
  const brief = await buildBrief(roots, roots.pilot, { scope: input.scope, cwd: input.cwd });
  const value = { schemaVersion: 1, runId: input.runId, parentRunId: input.parentRunId, taskId: input.taskId, scope: input.scope, project: resolved.project, cwd: input.cwd, worktree: resolved.worktree, sourceRevision: resolved.worktree.head, inputRefs: brief.records.map((r) => ({ id: r.id, recordHash: r.recordHash })), allowedOutputPaths: input.allowedOutputPaths ?? [], allowedOperations: input.allowedOperations ?? [], constraints: input.constraints ?? [], deliverable: input.deliverable, verificationCommands: input.verificationCommands ?? [], freshness: { createdAt, expiresAt, briefHash: brief.briefHash }, notice: ENVELOPE_NOTICE };
  return { ...value, envelopeId: "env_" + digest(value).slice(7, 31) };
}
export function checkEnvelopeFresh(envelope, { now = () => new Date(), head }) {
  const reasons = [];
  if (now().getTime() > Date.parse(envelope.freshness.expiresAt)) reasons.push("EXPIRED");
  if (head !== envelope.worktree.head) reasons.push("HEAD_MOVED");
  return { fresh: reasons.length === 0, reasons };
}
export function completionDraft(envelope, { actor, lastVerifiedResult, evidence = [], changedFiles = [], nextAction, blockers = [] }) {
  const body = ["Last verified result: " + lastVerifiedResult, "Evidence: " + evidence.join(", "), "Changed files: " + changedFiles.join(", "), "Next action: " + nextAction, "Blockers: " + blockers.join(", ")].join("\n");
  return { scope: envelope.scope, project: envelope.project, recordedBy: { actor, runId: envelope.runId }, draft: { kind: "handoff", status: "proposed", title: "Task handoff " + envelope.taskId, body, sources: evidence.map((ref) => ({ ref })), applicability: { level: "commit", commit: envelope.worktree.head, branch: envelope.worktree.branch }, review: null } };
}

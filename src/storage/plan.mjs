import { readFileSync } from "node:fs";
import { digest, sha256 } from "./canonical.mjs";
import { DevctxError } from "../errors.mjs";
export const REQUEST_ID = /^req_[a-z0-9_-]{8,64}$/;
export function finalizePlan(plan) {
  const { fingerprint, ...body } = plan;
  return { ...body, fingerprint: digest(body) };
}
export function assertFingerprint(plan, expected) {
  if (!expected) throw new DevctxError("PLAN_REQUIRED", "Plan fingerprint required");
  if (expected !== plan.fingerprint) throw new DevctxError("PLAN_MISMATCH", "Plan fingerprint mismatch");
}
export function checkPreconditions(entries) {
  for (const entry of entries) {
    let current;
    try { current = sha256(readFileSync(entry.path)); } catch (error) { if (error.code === "ENOENT") current = "absent"; else throw error; }
    if (current !== entry.expect) throw new DevctxError("STALE_VERSION", "Precondition changed");
  }
}
export function onboardRequest(input) {
  const sorted = (key) => [...(input[key] ?? [])].sort();
  const accept = Array.isArray(input.accept) ? [...input.accept].sort() : input.accept ?? "none";
  if (!(accept === "none" || accept === "all" || Array.isArray(accept))) throw new DevctxError("INVALID_INPUT", "Invalid accept selection");
  return { kind: "onboard", scope: input.scope, project: input.project, repo: input.repo, approvedDocs: sorted("approvedDocs"), expectedRemotes: sorted("expectedRemotes"), environments: sorted("environments"), actorRefs: sorted("actorRefs"), accept };
}
export const requestHashFor = (request) => digest(request);
export const deterministicRequestId = (kind, request) => "req_" + digest({ kind, request }).slice(7, 31);

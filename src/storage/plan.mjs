import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { digest, sha256 } from "./canonical.mjs";
import { DevctxError } from "../errors.mjs";
export const REQUEST_ID = /^req_[a-z0-9_-]{8,64}$/;
export function finalizePlan(plan) {
  const { fingerprint, ...body } = plan;
  return { ...body, fingerprint: digest(body) };
}
export function assertFingerprint(plan, expected) {
  if (!expected) throw new DevctxError("PLAN_REQUIRED", "Plan fingerprint required");
  if (expected !== plan.fingerprint || plan.fingerprint !== finalizePlan(plan).fingerprint) throw new DevctxError("PLAN_MISMATCH", "Plan fingerprint mismatch");
}
export function checkPreconditions(entries) {
  for (const entry of entries) {
    let current;
    let fd;
    try {
      fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 1048576) throw new DevctxError("STALE_VERSION", "Precondition unsafe");
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
      if (off !== st.size) throw new DevctxError("STALE_VERSION", "Precondition changed");
      current = sha256(buf);
    } catch (error) {
      if (error.code === "ENOENT") current = "absent";
      else throw new DevctxError("STALE_VERSION", "Precondition unsafe");
    } finally { if (fd !== undefined) closeSync(fd); }
    if (current !== entry.expect) throw new DevctxError("STALE_VERSION", "Precondition changed");
  }
}
export function onboardRequest(input) {
  const sorted = (key) => {
    const values = input[key] ?? [];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new DevctxError("INVALID_INPUT", "Invalid request list");
    return [...new Set(values)].sort();
  };
  const selection = typeof input.accept === "string" && /^c[0-9]{2}(,c[0-9]{2})*$/.test(input.accept) ? input.accept.split(",") : input.accept ?? "none";
  let accept = selection;
  if (Array.isArray(selection)) {
    if (selection.some((value) => typeof value !== "string" || !/^c[0-9]{2}$/.test(value))) throw new DevctxError("INVALID_INPUT", "Invalid accept selection");
    accept = selection.length ? [...new Set(selection)].sort() : "none";
  }
  if (!(accept === "none" || accept === "all" || Array.isArray(accept))) throw new DevctxError("INVALID_INPUT", "Invalid accept selection");
  return { kind: "onboard", scope: input.scope, project: input.project, repo: input.repo, approvedDocs: sorted("approvedDocs"), expectedRemotes: sorted("expectedRemotes"), environments: sorted("environments"), actorRefs: sorted("actorRefs"), accept };
}
export const requestHashFor = (request) => digest(request);
export const deterministicRequestId = (kind, request) => "req_" + digest({ kind, request }).slice(7, 31);

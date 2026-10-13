import { createHash } from "node:crypto";
import { DevctxError } from "../errors.mjs";
import { digest } from "../storage/canonical.mjs";
export const SCOPE_ID = /^[a-z][a-z0-9-]{1,31}$/;
export const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const RECORD_ID = /^rec_[a-f0-9]{24}$/;
export const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const ACTOR_REF = /^(email|github|slack|linear|handle):[A-Za-z0-9._@+-]{1,128}$/;
const invalid = () => { throw new DevctxError("INVALID_ID", "Invalid identifier"); };
export function assertScopeId(id) { if (typeof id !== "string" || !SCOPE_ID.test(id)) invalid(); return id; }
export function assertProjectId(id, scope) { if (typeof id !== "string" || id.length > 96 || !PROJECT_ID.test(id) || !id.startsWith(scope + ".")) invalid(); return id; }
export function assertAgent(id) { if (typeof id !== "string" || !AGENT_ID.test(id)) invalid(); return id; }
export function assertActorRef(id) { if (typeof id !== "string" || !ACTOR_REF.test(id)) invalid(); return id; }
const hex = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);
function checkRequest({ scope, project, requestId }) {
  assertScopeId(scope); assertProjectId(project, scope);
  if (typeof requestId !== "string" || !/^req_[a-z0-9_-]{8,64}$/.test(requestId)) invalid();
}
// Record IDs are derived, never trusted from disk: readBundle recomputes recordIdFor from the stored scope, project and requestId.
export const recordIdFor = (value) => { checkRequest(value); return "rec_" + hex(value.scope + "\0" + value.project + "\0" + value.requestId); };
// Operation IDs are stamped only by onboarding (commitOnboardingBundle); public record APIs refuse them and readSnapshot trusts one only when its manifest lists the record.
export const operationIdFor = (value) => { checkRequest(value); return "op_" + digest({ scope: value.scope, project: value.project, requestId: value.requestId }).slice(7, 31); };

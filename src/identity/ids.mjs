import { createHash } from "node:crypto";
import { DevctxError } from "../errors.mjs";
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
export const recordIdFor = ({ scope, project, requestId }) => "rec_" + hex(scope + "\0" + project + "\0" + requestId);
export const operationIdFor = ({ scope, project, requestId }) => "op_" + hex(JSON.stringify({ scope, project, requestId }));
